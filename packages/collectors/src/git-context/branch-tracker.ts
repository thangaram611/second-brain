import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chokidar from 'chokidar';

export interface BranchTrackerOptions {
  /** Absolute path to the repo root (worktree cwd). */
  repoRoot: string;
  /** Invoked whenever the branch changes (debounced). */
  onBranchChange: (event: BranchChangeEvent) => void | Promise<void>;
  /** Debounce window for rapid rebase/checkout bursts. Default 200ms. */
  debounceMs?: number;
  /** Error surface. */
  onError?: (err: unknown) => void;
}

export interface BranchChangeEvent {
  from: string;
  to: string;
  headSha: string;
  at: string;
}

export interface BranchTrackerHandle {
  /** Current branch name (or detached:<shortsha>) — resolves when the tracker is ready. */
  current(): Promise<string>;
  /** Force a re-read of HEAD; useful after external edits. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Read `.git/HEAD`. For the usual branch pointer the file looks like:
 *   `ref: refs/heads/feature/foo\n`
 * For a detached HEAD it contains the raw commit sha. Worktrees use a `.git`
 * file (not directory) whose single line is `gitdir: <path>` pointing at the
 * real git dir under `.git/worktrees/<name>`; we follow that indirection.
 */
export async function resolveGitDir(repoRoot: string): Promise<string> {
  const dotGit = path.join(repoRoot, '.git');
  const stat = await fs.stat(dotGit).catch(() => null);
  if (!stat) throw new Error(`not a git repo: ${repoRoot}`);
  if (stat.isDirectory()) return dotGit;
  // Worktree file: `gitdir: /abs/path/.git/worktrees/<name>`
  const content = await fs.readFile(dotGit, 'utf8');
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) throw new Error(`malformed .git file at ${dotGit}`);
  return path.resolve(repoRoot, match[1].trim());
}

export async function readHead(gitDir: string): Promise<{ branch: string; sha: string }> {
  const headPath = path.join(gitDir, 'HEAD');
  const raw = await fs.readFile(headPath, 'utf8');
  const trimmed = raw.trim();
  const refMatch = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) {
    const branch = refMatch[1];
    const sha = await resolveRefSha(gitDir, branch);
    return { branch, sha };
  }
  // Detached HEAD — raw sha
  return { branch: `detached:${trimmed.slice(0, 7)}`, sha: trimmed };
}

async function resolveRefSha(gitDir: string, branch: string): Promise<string> {
  // Loose ref
  const loose = path.join(gitDir, 'refs', 'heads', branch);
  const looseContent = await fs.readFile(loose, 'utf8').catch(() => null);
  if (looseContent) return looseContent.trim();
  // Packed refs
  const packedPath = path.join(gitDir, 'packed-refs');
  const packed = await fs.readFile(packedPath, 'utf8').catch(() => null);
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      if (line.startsWith('#') || line.startsWith('^') || !line.trim()) continue;
      const [sha, ref] = line.split(/\s+/, 2);
      if (ref === `refs/heads/${branch}`) return sha.trim();
    }
  }
  return '';
}

/**
 * Track `.git/HEAD` for branch changes. Emits one debounced event per
 * change (rapid rebase/bisect → single event). Worktree-aware.
 */
export async function createBranchTracker(
  options: BranchTrackerOptions,
): Promise<BranchTrackerHandle> {
  const debounceMs = options.debounceMs ?? 200;
  const onError = options.onError ?? ((err) => console.error('[branch-tracker]', err));
  const gitDir = await resolveGitDir(options.repoRoot);
  const headPath = path.join(gitDir, 'HEAD');

  let currentBranch: string;
  let currentSha: string;
  {
    const head = await readHead(gitDir);
    currentBranch = head.branch;
    currentSha = head.sha;
  }

  let timer: NodeJS.Timeout | null = null;
  const scheduleRead = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        try {
          const next = await readHead(gitDir);
          if (next.branch !== currentBranch) {
            const event: BranchChangeEvent = {
              from: currentBranch,
              to: next.branch,
              headSha: next.sha,
              at: new Date().toISOString(),
            };
            currentBranch = next.branch;
            currentSha = next.sha;
            await options.onBranchChange(event);
          } else if (next.sha !== currentSha) {
            // Same branch, new commit — track sha but don't emit a branch-change.
            currentSha = next.sha;
          }
        } catch (err) {
          onError(err);
        }
      })();
    }, debounceMs);
  };

  const watcher = chokidar.watch(headPath, { persistent: true, ignoreInitial: true });
  watcher.on('change', () => scheduleRead());
  watcher.on('error', (err) => onError(err));
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

  return {
    async current() {
      return currentBranch;
    },
    async refresh() {
      scheduleRead();
    },
    async close() {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
