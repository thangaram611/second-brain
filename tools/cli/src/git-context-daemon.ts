import { startFileChangeCollector } from '@second-brain/collectors';
import type { FileChangeCollectorHandle } from '@second-brain/collectors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

export interface WatchOptions {
  repo: string;
  namespace?: string;
  serverUrl?: string;
  bearerToken?: string;
  authorEmail?: string;
  authorName?: string;
  extraDenyGlobs?: readonly string[];
}

const WiredReposEntrySchema = z.object({
  repoHash: z.string(),
  absPath: z.string(),
  namespace: z.string(),
  providerId: z.string().optional(),
  projectId: z.string().optional(),
  relayUrl: z.string().optional(),
  installedAt: z.string(),
});

const WiredReposSchema = z.object({
  version: z.literal(1),
  wiredRepos: z.record(z.string(), WiredReposEntrySchema),
});

export type WiredReposEntry = z.infer<typeof WiredReposEntrySchema>;
export type WiredRepos = z.infer<typeof WiredReposSchema>;

const CONFIG_DIR = path.join(os.homedir(), '.second-brain');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'hook.log');

export function loadWiredRepos(): WiredRepos {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = WiredReposSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // fall through to default
  }
  return { version: 1, wiredRepos: {} };
}

export function saveWiredRepos(repos: WiredRepos): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(repos, null, 2) + '\n', 'utf8');
}

export function computeRepoHash(repoRoot: string): string {
  // Deterministic short identifier. In a worktree the plan says use
  // `git rev-parse --git-common-dir` so all worktrees share one repoHash —
  // resolving that requires a git call; here we just normalize + hash the
  // absolute path. The wire step upgrades to common-dir hashing when it
  // runs (daemon runs against a concrete path, so equality-by-path is fine).
  const normalized = path.resolve(repoRoot).toLowerCase();
  // djb2 — fast and stable for a ~10-char label.
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
  }
  const unsigned = h >>> 0;
  return unsigned.toString(36);
}

function logLine(msg: string): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Never let logging failures crash the daemon.
  }
}

export async function runWatch(options: WatchOptions): Promise<FileChangeCollectorHandle> {
  const repoRoot = path.resolve(options.repo);
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`not a git repo: ${repoRoot}`);
  }
  const wired = loadWiredRepos();
  const repoHash = computeRepoHash(repoRoot);
  const entry = wired.wiredRepos[repoHash];
  const namespace = options.namespace ?? entry?.namespace ?? 'personal';
  const serverUrl = options.serverUrl ?? process.env.SECOND_BRAIN_SERVER_URL ?? 'http://localhost:7430';
  const bearerToken = options.bearerToken ?? process.env.SECOND_BRAIN_TOKEN;

  const author = options.authorEmail
    ? { canonicalEmail: options.authorEmail, displayName: options.authorName }
    : undefined;

  logLine(`[watch] start repo=${repoRoot} ns=${namespace} serverUrl=${serverUrl}`);

  const handle = await startFileChangeCollector({
    repoRoot,
    namespace,
    serverUrl,
    bearerToken,
    author,
    extraDenyGlobs: options.extraDenyGlobs,
    onError: (err) => logLine(`[watch] error ${err instanceof Error ? err.message : String(err)}`),
  });

  const shutdown = async (): Promise<void> => {
    logLine('[watch] shutdown');
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  await handle.ready();
  logLine(`[watch] ready branch=${await handle.currentBranch()}`);
  return handle;
}
