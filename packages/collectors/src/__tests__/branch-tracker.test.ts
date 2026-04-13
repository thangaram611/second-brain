import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createBranchTracker,
  readHead,
  resolveGitDir,
  type BranchTrackerHandle,
  type BranchChangeEvent,
} from '../git-context/branch-tracker.js';

let tmpDir: string;
let tracker: BranchTrackerHandle | null = null;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-branch-test-'));
  git(['init', '-q', '-b', 'main'], tmpDir);
  git(['config', 'user.email', 'test@example.com'], tmpDir);
  git(['config', 'user.name', 'Test'], tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n');
  git(['add', 'a.txt'], tmpDir);
  git(['commit', '-q', '-m', 'init'], tmpDir);
});

afterEach(async () => {
  if (tracker) {
    await tracker.close();
    tracker = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readHead', () => {
  it('returns branch + sha for a normal ref', async () => {
    const gitDir = await resolveGitDir(tmpDir);
    const head = await readHead(gitDir);
    expect(head.branch).toBe('main');
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns detached:<shortsha> for detached HEAD', async () => {
    const sha = git(['rev-parse', 'HEAD'], tmpDir);
    git(['checkout', '-q', '--detach', sha], tmpDir);
    const gitDir = await resolveGitDir(tmpDir);
    const head = await readHead(gitDir);
    expect(head.branch).toBe(`detached:${sha.slice(0, 7)}`);
    expect(head.sha).toBe(sha);
  });

  it('follows worktree .git file indirection', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-worktree-'));
    try {
      git(['worktree', 'add', worktreePath, '-b', 'feat/wt'], tmpDir);
      const gitDir = await resolveGitDir(worktreePath);
      expect(gitDir).toContain('worktrees');
      const head = await readHead(gitDir);
      expect(head.branch).toBe('feat/wt');
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('handles packed-refs fallback', async () => {
    git(['pack-refs', '--all'], tmpDir);
    const gitDir = await resolveGitDir(tmpDir);
    const head = await readHead(gitDir);
    expect(head.branch).toBe('main');
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('resolveGitDir', () => {
  it('throws on non-git directory', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-nogit-'));
    try {
      await expect(resolveGitDir(nonGit)).rejects.toThrow(/not a git repo/);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('createBranchTracker', () => {
  it('reports current branch after start', async () => {
    tracker = await createBranchTracker({
      repoRoot: tmpDir,
      onBranchChange: () => {},
      debounceMs: 50,
    });
    expect(await tracker.current()).toBe('main');
  });

  it('emits onBranchChange when HEAD flips to a new branch', async () => {
    const events: BranchChangeEvent[] = [];
    tracker = await createBranchTracker({
      repoRoot: tmpDir,
      onBranchChange: (ev) => {
        events.push(ev);
      },
      debounceMs: 50,
    });
    await new Promise((r) => setTimeout(r, 50));

    git(['checkout', '-q', '-b', 'feature/x'], tmpDir);

    // Wait up to 2s for the debounced event
    const started = Date.now();
    while (events.length === 0 && Date.now() - started < 2000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].from).toBe('main');
    expect(events[0].to).toBe('feature/x');
    expect(await tracker.current()).toBe('feature/x');
  });

  it('does NOT emit for same-branch new commits (only sha changes)', async () => {
    const events: BranchChangeEvent[] = [];
    tracker = await createBranchTracker({
      repoRoot: tmpDir,
      onBranchChange: (ev) => {
        events.push(ev);
      },
      debounceMs: 50,
    });
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'more\n');
    git(['add', 'b.txt'], tmpDir);
    git(['commit', '-q', '-m', 'more'], tmpDir);

    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(0);
  });

  it('debounces rapid checkouts to one event per destination', async () => {
    const events: BranchChangeEvent[] = [];
    tracker = await createBranchTracker({
      repoRoot: tmpDir,
      onBranchChange: (ev) => {
        events.push(ev);
      },
      debounceMs: 100,
    });
    await new Promise((r) => setTimeout(r, 50));
    git(['checkout', '-q', '-b', 'a'], tmpDir);
    git(['checkout', '-q', '-b', 'b'], tmpDir);
    await new Promise((r) => setTimeout(r, 500));
    // Strict ≤2 — we allow 1 or 2 due to timing variance but refuse bursts of ≥3.
    expect(events.length).toBeLessThanOrEqual(2);
    expect(events[events.length - 1].to).toBe('b');
  });
});
