import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Brain } from '@second-brain/core';
import { loadCodeowners } from './codeowners.js';

const execFileAsync = promisify(execFile);

/** A node in the ownership tree returned by {@link OwnershipService.queryTree}. */
export interface OwnershipNode {
  path: string;
  name: string;
  isDir: boolean;
  owners?: Array<{ actor: string; score: number }>;
  children?: OwnershipNode[];
}

/**
 * Directories the tree walker never descends into. Without this, a default-depth
 * request on a repo root recurses into `node_modules` (tens of thousands of
 * files), issuing one ownership query per file until the request times out.
 * Mirrors the indexing pipeline's ignore patterns.
 */
const OWNERSHIP_TREE_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  'build',
  '.next',
  '.cache',
]);

/** Default ceiling on concurrent per-file ownership queries during a tree walk. */
const DEFAULT_TREE_CONCURRENCY = 12;

/**
 * Minimal async semaphore. Each {@link OwnershipService.query} spawns several
 * `git` subprocesses, so the tree walk must cap how many run at once — an
 * unbounded `Promise.all` over a large repo would fork-bomb git. This bounds
 * total in-flight queries across the whole (recursive) walk, not per directory.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** Boundary schema for the reviewed_by relation join rows. */
const ReviewRowSchema = z.object({
  target_id: z.string(),
  properties: z.string(),
});

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
  /**
   * Namespace scope for the review-signal lookup. Required — every caller
   * must resolve a namespace via `resolveScopedNamespace()` before invoking
   * the service so cross-namespace bleed is impossible. Routes that receive
   * an unbound token without `?namespace=` short-circuit at the route layer
   * (400 namespace-required) and never reach this method.
   */
  namespace: string;
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
  private readonly treeConcurrency: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    brain: Brain,
    options?: {
      cacheTtlMs?: number;
      repoRoot?: string;
      simpleGit?: SimpleGitFactory;
      /** Max concurrent per-file git queries during a tree walk. Default 12. */
      treeConcurrency?: number;
    },
  ) {
    this.brain = brain;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.repoRoot = options?.repoRoot ?? '.';
    this.gitFactory = options?.simpleGit ?? defaultGitFactory;
    this.treeConcurrency = options?.treeConcurrency ?? DEFAULT_TREE_CONCURRENCY;
  }

  /** Resolved repository root path used for directory walking. */
  get root(): string {
    return this.repoRoot;
  }

  /**
   * Walk the directory subtree at `path` (relative to the repo root) and score
   * ownership for every file, to `depth` levels. Per-file queries run through a
   * bounded semaphore so a large tree doesn't spawn thousands of concurrent
   * `git` processes. Directory entries keep their on-disk (readdir) order.
   * Throws an ENOENT-coded error if the top path does not exist.
   */
  async queryTree(opts: {
    path: string;
    depth: number;
    limit: number;
    namespace: string;
  }): Promise<OwnershipNode> {
    const absPath = nodePath.join(this.repoRoot, opts.path);
    if (!fs.existsSync(absPath)) {
      throw Object.assign(new Error(`Path not found: ${opts.path}`), { code: 'ENOENT' });
    }
    const sem = new Semaphore(this.treeConcurrency);
    return this.walkTree(absPath, opts.path, opts.depth, opts.limit, opts.namespace, sem);
  }

  private async ownersFor(
    relPath: string,
    limit: number,
    namespace: string,
    sem: Semaphore,
  ): Promise<Array<{ actor: string; score: number }>> {
    try {
      const scores = await sem.run(() => this.query({ path: relPath, limit, namespace }));
      return scores.map((s) => ({ actor: s.actor, score: s.score }));
    } catch {
      // file not tracked by git or other query failure — return empty owners
      return [];
    }
  }

  private async walkTree(
    absPath: string,
    relPath: string,
    depth: number,
    limit: number,
    namespace: string,
    sem: Semaphore,
  ): Promise<OwnershipNode> {
    const stat = fs.statSync(absPath, { throwIfNoEntry: false });
    if (!stat) {
      throw Object.assign(new Error(`Path not found: ${relPath}`), { code: 'ENOENT' });
    }

    const name = nodePath.basename(relPath) || relPath;

    if (!stat.isDirectory()) {
      return { path: relPath, name, isDir: false, owners: await this.ownersFor(relPath, limit, namespace, sem) };
    }

    if (depth <= 0) {
      return { path: relPath, name, isDir: true, children: [] };
    }

    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    // Fan out children concurrently; the semaphore inside ownersFor caps how
    // many git queries actually run at once. Order is preserved by collecting
    // the promises in readdir order and awaiting them together.
    const childPromises: Array<Promise<OwnershipNode>> = [];
    for (const entry of entries) {
      if (entry.isDirectory() && OWNERSHIP_TREE_IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const childRel = relPath === '.' ? entry.name : nodePath.join(relPath, entry.name);
      const childAbs = nodePath.join(absPath, entry.name);

      if (entry.isDirectory()) {
        childPromises.push(this.walkTree(childAbs, childRel, depth - 1, limit, namespace, sem));
      } else if (entry.isFile()) {
        childPromises.push(
          this.ownersFor(childRel, limit, namespace, sem).then((owners) => ({
            path: childRel,
            name: entry.name,
            isDir: false,
            owners,
          })),
        );
      }
    }

    return { path: relPath, name, isDir: true, children: await Promise.all(childPromises) };
  }

  async query(q: OwnershipQuery): Promise<OwnershipScore[]> {
    const root = q.repoRoot ?? this.repoRoot;
    const limit = q.limit ?? 3;
    // Namespace is part of the cache key — the review-signal lookup is the
    // only namespace-sensitive component, but two callers querying the same
    // file in different namespaces must not share a cache slot.
    const cacheKey = `${root}:${q.namespace}:${q.path}`;

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

    const reviewMap = this.getReviewSignals(q.path, q.namespace);
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
   * entity is a merge_request/pull_request (in `namespace`) that touches this
   * file path. Namespace-scoped to prevent leaking review signals across
   * namespaces (e.g. two unrelated teams indexing the same path fragment).
   */
  private getReviewSignals(path: string, namespace: string): Map<string, number> {
    const result = new Map<string, number>();
    try {
      const db = this.brain.storage.sqlite;
      const rows = z.array(ReviewRowSchema).parse(
        db
          .prepare(
            `SELECT r.target_id, r.properties
             FROM relations r
             JOIN entities e ON e.id = r.source_id
             WHERE r.type = 'reviewed_by'
               AND (e.type = 'merge_request' OR e.type = 'pull_request')
               AND e.namespace = ?
               AND json_extract(e.properties, '$.touches_file') LIKE ?`,
          )
          .all(namespace, `%${path}%`),
      );

      for (const row of rows) {
        // target_id is the reviewer entity — look up its email/name
        const reviewer = this.brain.entities.get(row.target_id);
        const email = reviewer?.properties.email;
        const actor =
          (typeof email === 'string' ? email : undefined) ??
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
