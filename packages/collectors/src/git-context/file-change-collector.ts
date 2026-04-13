import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWatcher, type WatcherHandle, type WatchChange } from '../watch/watcher.js';
import { filterNoise, type NoiseFilterOptions } from './noise-filter.js';
import { createBranchTracker, type BranchTrackerHandle } from './branch-tracker.js';

export interface FileChangeCollectorOptions {
  repoRoot: string;
  namespace: string;
  /** HTTP endpoint for /api/observe/file-change (e.g. http://localhost:7430). */
  serverUrl: string;
  /** Bearer token for the server. */
  bearerToken?: string;
  /** Author to stamp on batches — resolved once at daemon start. */
  author?: { canonicalEmail: string; displayName?: string };
  /** Additional glob suffixes to treat as noise. */
  extraDenyGlobs?: readonly string[];
  /** Debounce window for the underlying watcher. Default 500ms. */
  debounceMs?: number;
  /** Content-stability wait (0 disables). Default 3000ms. */
  stabilityWaitMs?: number;
  /** Override fetch (for tests). */
  fetchFn?: typeof fetch;
  /** Error surface. */
  onError?: (err: unknown) => void;
}

export interface FileChangeCollectorHandle {
  /** Resolves once both the watcher and branch tracker are ready. */
  ready(): Promise<void>;
  close(): Promise<void>;
  /** Expose the branch tracker for daemon UI / health checks. */
  currentBranch(): Promise<string>;
}

function computeIdempotencyKey(
  repoRoot: string,
  branch: string,
  changes: ReadonlyArray<WatchChange>,
  batchedAt: string,
): string {
  const canonical = changes
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((c) => `${c.kind}:${c.path}`)
    .join('|');
  return createHash('sha256')
    .update(`${repoRoot}::${branch}::${canonical}::${batchedAt}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Start watching a repo. On every debounced file-change batch:
 *   1. filter noise (lockfiles, build output, formatter flicker)
 *   2. read current branch from the tracker
 *   3. POST /api/observe/file-change with an idempotency key derived from
 *      (repo, branch, paths+kinds, batchedAt)
 *
 * Branch-change events flush the current batch through before the swap so
 * observations never straddle branches.
 */
export async function startFileChangeCollector(
  options: FileChangeCollectorOptions,
): Promise<FileChangeCollectorHandle> {
  const onError = options.onError ?? ((err) => console.error('[file-change-collector]', err));
  const fetchImpl = options.fetchFn ?? fetch;

  const noiseOpts: NoiseFilterOptions = {
    repoRoot: options.repoRoot,
    extraDenyGlobs: options.extraDenyGlobs,
    stabilityWaitMs: options.stabilityWaitMs,
  };

  let pendingByBranch: Map<string, WatchChange[]> = new Map();

  const postBatch = async (branch: string, changes: WatchChange[]): Promise<void> => {
    if (changes.length === 0) return;
    const batchedAt = new Date().toISOString();
    const idempotencyKey = computeIdempotencyKey(options.repoRoot, branch, changes, batchedAt);
    const body = {
      repo: options.repoRoot,
      namespace: options.namespace,
      branch,
      author: options.author,
      changes: await Promise.all(
        changes.map(async (c) => {
          const abs = path.isAbsolute(c.path) ? c.path : path.join(options.repoRoot, c.path);
          const relPath = path.relative(options.repoRoot, abs);
          let size: number | undefined;
          let mtime = new Date().toISOString();
          if (c.kind !== 'unlink') {
            const st = await fs.stat(abs).catch(() => null);
            if (st) {
              size = st.size;
              mtime = new Date(st.mtimeMs).toISOString();
            }
          }
          return { path: relPath, kind: c.kind, size, mtime };
        }),
      ),
      batchedAt,
      idempotencyKey,
    };
    const res = await fetchImpl(`${options.serverUrl}/api/observe/file-change`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => '');
      onError(new Error(`file-change POST failed: ${res.status} ${text}`));
    }
  };

  const flush = async (branch: string): Promise<void> => {
    const buf = pendingByBranch.get(branch) ?? [];
    if (buf.length === 0) return;
    pendingByBranch.delete(branch);
    const filtered = await filterNoise(buf, noiseOpts);
    await postBatch(branch, filtered).catch(onError);
  };

  let tracker: BranchTrackerHandle | null = null;
  let watcher: WatcherHandle | null = null;

  tracker = await createBranchTracker({
    repoRoot: options.repoRoot,
    debounceMs: 200,
    onBranchChange: async ({ from, to, headSha }) => {
      // Flush observations against the OLD branch before swapping.
      await flush(from);
      await fetchImpl(`${options.serverUrl}/api/observe/branch-change`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
        },
        body: JSON.stringify({
          repo: options.repoRoot,
          namespace: options.namespace,
          from,
          to,
          headSha,
          author: options.author,
          timestamp: new Date().toISOString(),
        }),
      }).catch(onError);
    },
    onError,
  });

  watcher = createWatcher({
    roots: [options.repoRoot],
    debounceMs: options.debounceMs ?? 500,
    onBatch: async (batch) => {
      const branch = await tracker!.current();
      const buf = pendingByBranch.get(branch) ?? [];
      buf.push(...batch);
      pendingByBranch.set(branch, buf);
      await flush(branch);
    },
    onError,
  });

  return {
    async ready() {
      await watcher?.ready;
    },
    async currentBranch() {
      return (await tracker?.current()) ?? 'unknown';
    },
    async close() {
      await watcher?.close();
      await tracker?.close();
    },
  };
}
