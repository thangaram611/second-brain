import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Brain } from '@second-brain/core';
import { loadCodeowners, type CodeownersResult } from './codeowners.js';

const execFileAsync = promisify(execFile);

export interface OwnershipScore {
  actor: string;
  score: number;
  signals: {
    commits: number;
    recencyWeightedBlameLines: number;
    reviews: number;
    testAuthorship: number;
    codeownerMatch: boolean;
  };
}

export interface OwnershipQuery {
  path: string;
  limit?: number;
  repoRoot?: string;
}

export type SimpleGitFactory = (repoRoot: string) => {
  log(args: string[]): Promise<string>;
  blame(args: string[]): Promise<string>;
};

interface CacheEntry {
  result: OwnershipScore[];
  cachedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function defaultGitFactory(repoRoot: string) {
  return {
    async log(args: string[]): Promise<string> {
      const { stdout } = await execFileAsync('git', ['log', ...args], { cwd: repoRoot });
      return stdout;
    },
    async blame(args: string[]): Promise<string> {
      const { stdout } = await execFileAsync('git', ['blame', ...args], { cwd: repoRoot });
      return stdout;
    },
  };
}

export class OwnershipService {
  private readonly brain: Brain;
  private readonly cacheTtlMs: number;
  private readonly repoRoot: string;
  private readonly gitFactory: SimpleGitFactory;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    brain: Brain,
    options?: {
      cacheTtlMs?: number;
      repoRoot?: string;
      simpleGit?: SimpleGitFactory;
    },
  ) {
    this.brain = brain;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.repoRoot = options?.repoRoot ?? '.';
    this.gitFactory = options?.simpleGit ?? defaultGitFactory;
  }

  async query(q: OwnershipQuery): Promise<OwnershipScore[]> {
    const root = q.repoRoot ?? this.repoRoot;
    const limit = q.limit ?? 3;
    const cacheKey = `${root}:${q.path}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.result.slice(0, limit);
    }

    const git = this.gitFactory(root);

    // Gather raw signals in parallel
    const [blameMap, commitMap, testMap] = await Promise.all([
      this.getRecencyWeightedBlame(git, q.path),
      this.getCommitCounts(git, q.path),
      this.getTestAuthorship(git, q.path),
    ]);

    const reviewMap = this.getReviewSignals(q.path);
    const codeowners = loadCodeowners(root);
    const codeownerOwners = new Set(codeowners?.match(q.path) ?? []);

    // Collect all actors
    const actors = new Set<string>();
    for (const k of blameMap.keys()) actors.add(k);
    for (const k of commitMap.keys()) actors.add(k);
    for (const k of reviewMap.keys()) actors.add(k);
    for (const k of testMap.keys()) actors.add(k);
    for (const o of codeownerOwners) actors.add(o);

    if (actors.size === 0) {
      const empty: OwnershipScore[] = [];
      this.cache.set(cacheKey, { result: empty, cachedAt: Date.now() });
      return empty;
    }

    // Find max per dimension for normalization
    const maxBlame = maxValue(blameMap);
    const maxCommits = maxValue(commitMap);
    const maxReviews = maxValue(reviewMap);
    const maxTests = maxValue(testMap);

    const scores: OwnershipScore[] = [];
    for (const actor of actors) {
      const rawBlame = blameMap.get(actor) ?? 0;
      const rawCommits = commitMap.get(actor) ?? 0;
      const rawReviews = reviewMap.get(actor) ?? 0;
      const rawTests = testMap.get(actor) ?? 0;
      const isCo = codeownerOwners.has(actor);

      const normBlame = maxBlame > 0 ? rawBlame / maxBlame : 0;
      const normCommits = maxCommits > 0 ? rawCommits / maxCommits : 0;
      const normReviews = maxReviews > 0 ? rawReviews / maxReviews : 0;
      const normTests = maxTests > 0 ? rawTests / maxTests : 0;
      const normCo = isCo ? 1 : 0;

      const composite =
        0.40 * normBlame +
        0.20 * normCommits +
        0.20 * normReviews +
        0.10 * normTests +
        0.10 * normCo;

      scores.push({
        actor,
        score: composite,
        signals: {
          commits: rawCommits,
          recencyWeightedBlameLines: rawBlame,
          reviews: rawReviews,
          testAuthorship: rawTests,
          codeownerMatch: isCo,
        },
      });
    }

    scores.sort((a, b) => b.score - a.score);

    this.cache.set(cacheKey, { result: scores, cachedAt: Date.now() });
    return scores.slice(0, limit);
  }

  /**
   * Parse `git blame --line-porcelain` output.
   * Each line's weight = exp(-age_days / 90).
   */
  private async getRecencyWeightedBlame(
    git: { blame(args: string[]): Promise<string> },
    path: string,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    let raw: string;
    try {
      raw = await git.blame(['--line-porcelain', path]);
    } catch {
      return result;
    }

    const now = Date.now() / 1000;
    let currentEmail: string | undefined;
    let currentTime: number | undefined;

    for (const line of raw.split('\n')) {
      if (line.startsWith('author-mail ')) {
        currentEmail = line.slice('author-mail '.length).replace(/[<>]/g, '').trim();
      } else if (line.startsWith('author-time ')) {
        currentTime = parseInt(line.slice('author-time '.length), 10);
      } else if (line.startsWith('\t')) {
        // Content line — signals end of a blame entry
        if (currentEmail && currentTime !== undefined) {
          const ageDays = (now - currentTime) / 86400;
          const weight = Math.exp(-ageDays / 90);
          result.set(currentEmail, (result.get(currentEmail) ?? 0) + weight);
        }
        currentEmail = undefined;
        currentTime = undefined;
      }
    }
    return result;
  }

  /**
   * Count commits per author email for a file.
   */
  private async getCommitCounts(
    git: { log(args: string[]): Promise<string> },
    path: string,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    let raw: string;
    try {
      raw = await git.log(['--follow', '--format=%ae', '--', path]);
    } catch {
      return result;
    }

    for (const line of raw.split('\n')) {
      const email = line.trim();
      if (email === '') continue;
      result.set(email, (result.get(email) ?? 0) + 1);
    }
    return result;
  }

  /**
   * Query brain for review relations: type='reviewed_by' where the source
   * entity is a merge_request/pull_request that touches this file path.
   */
  private getReviewSignals(path: string): Map<string, number> {
    const result = new Map<string, number>();
    try {
      const db = this.brain.storage.sqlite;
      const rows = db
        .prepare(
          `SELECT r.target_id, r.properties
           FROM relations r
           JOIN entities e ON e.id = r.source_id
           WHERE r.type = 'reviewed_by'
             AND (e.type = 'merge_request' OR e.type = 'pull_request')
             AND json_extract(e.properties, '$.touches_file') LIKE ?`,
        )
        .all(`%${path}%`) as Array<{ target_id: string; properties: string }>;

      for (const row of rows) {
        // target_id is the reviewer entity — look up its email/name
        const reviewer = this.brain.entities.get(row.target_id);
        const actor =
          (reviewer?.properties as Record<string, unknown> | undefined)?.email as string ??
          reviewer?.name ??
          row.target_id;
        result.set(actor, (result.get(actor) ?? 0) + 1);
      }
    } catch {
      // Brain may not have the relation tables with expected shape
    }
    return result;
  }

  /**
   * Check if commits that touched `path` also touched a sibling test file.
   */
  private async getTestAuthorship(
    git: { log(args: string[]): Promise<string> },
    path: string,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const testPath = deriveTestPath(path);
    if (!testPath) return result;

    let raw: string;
    try {
      raw = await git.log(['--follow', '--format=%ae', '--', path, testPath]);
    } catch {
      return result;
    }

    for (const line of raw.split('\n')) {
      const email = line.trim();
      if (email === '') continue;
      result.set(email, (result.get(email) ?? 0) + 1);
    }
    return result;
  }
}

function maxValue(map: Map<string, number>): number {
  let max = 0;
  for (const v of map.values()) {
    if (v > max) max = v;
  }
  return max;
}

/**
 * Derive the sibling test file path for a source file.
 * e.g. `src/foo.ts` → `src/foo.test.ts`, `src/foo.tsx` → `src/foo.test.tsx`
 */
function deriveTestPath(path: string): string | null {
  const match = path.match(/^(.+)\.(ts|tsx|js|jsx)$/);
  if (!match) return null;
  // Don't derive test path for files that are already test files
  if (match[1].endsWith('.test') || match[1].endsWith('.spec')) return null;
  return `${match[1]}.test.${match[2]}`;
}
