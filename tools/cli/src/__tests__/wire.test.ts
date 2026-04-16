import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  installGitHooks,
  uninstallGitHooks,
  GIT_HOOK_NAMES,
} from '../install-git-hooks.js';

let tmpDir: string;
let savedHome: string | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function swapHome(newHome: string): void {
  savedHome = process.env.HOME;
  process.env.HOME = newHome;
}

function restoreHome(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  savedHome = undefined;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-test-'));
  git(['init', '-q', '-b', 'main'], tmpDir);
  git(['config', 'user.email', 'test@example.com'], tmpDir);
  git(['config', 'user.name', 'Test'], tmpDir);
});

afterEach(() => {
  restoreHome();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('installGitHooks / uninstallGitHooks', () => {
  it('writes post-commit, post-merge, post-checkout shims under .git/hooks', () => {
    const result = installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
    });
    expect(result.installed.sort()).toEqual([...GIT_HOOK_NAMES].sort());

    for (const name of GIT_HOOK_NAMES) {
      const hookPath = path.join(tmpDir, '.git', 'hooks', name);
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('Installed by second-brain `brain wire`');
      expect(content).toContain("SERVER_URL='http://localhost:7430'");
      expect(content).toContain('/api/observe/git-event');
      // Executable mode bit should be set.
      const mode = fs.statSync(hookPath).mode & 0o777;
      expect(mode & 0o100).toBeGreaterThan(0);
    }
    // Sidecar file exists
    expect(fs.existsSync(result.sidecarPath)).toBe(true);
  });

  it('backs up a pre-existing user hook before overwriting', () => {
    const userHook = path.join(tmpDir, '.git', 'hooks', 'post-commit');
    fs.mkdirSync(path.dirname(userHook), { recursive: true });
    fs.writeFileSync(userHook, '#!/bin/sh\necho user hook\n', { mode: 0o755 });

    const result = installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
    });
    const backup = result.backups.find((b) => b.name === 'post-commit');
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(backup!.path, 'utf8')).toContain('user hook');
  });

  it('uninstallGitHooks removes our hooks and restores backups', () => {
    // Pre-existing user hook
    const userHook = path.join(tmpDir, '.git', 'hooks', 'post-merge');
    fs.mkdirSync(path.dirname(userHook), { recursive: true });
    fs.writeFileSync(userHook, '#!/bin/sh\necho user merge\n', { mode: 0o755 });

    installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
    });
    const res = uninstallGitHooks(tmpDir);
    expect(res.removed.sort()).toEqual([...GIT_HOOK_NAMES].sort());
    expect(res.restored).toContain('post-merge');

    const restored = fs.readFileSync(userHook, 'utf8');
    expect(restored).toContain('user merge');
  });

  it('uninstallGitHooks is idempotent when nothing is installed', () => {
    const res = uninstallGitHooks(tmpDir);
    expect(res.removed).toEqual([]);
    expect(res.restored).toEqual([]);
  });

  it('safely escapes hostile namespace values (shell injection defense)', () => {
    // Namespace chosen to exercise every metacharacter a naive template
    // would break on: single-quote, double-quote, dollar, backtick,
    // backslash, newline. The installed hook should contain a
    // single-quoted literal that bash parses as an exact string.
    const hostile = `evil'; rm -rf / #`;
    installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: hostile,
    });
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    // Must NOT see the raw `rm -rf` as part of a command — only inside a
    // quoted literal. Our quoting scheme produces `'evil'\''; rm -rf / #'`.
    expect(hook).toContain(`NAMESPACE='evil'\\''; rm -rf / #'`);
    // Negative assertion: unquoted `rm -rf` at start of a line (would be a
    // command) must not appear.
    expect(hook).not.toMatch(/^rm -rf/m);
  });
});

describe('runWire / runUnwire (integration)', () => {
  it('writes a wiredRepos entry into HOME/.second-brain/config.json', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-home-'));
    try {
      swapHome(fakeHome);
      const { runWire } = await import('../wire.js');
      const { runUnwire } = await import('../unwire.js');

      const result = await runWire({
        repo: tmpDir,
        namespace: 'myproj',
        installClaudeSession: false,
      });
      expect(result.namespace).toBe('myproj');
      expect(result.gitHooks.installed.length).toBe(3);

      const configPath = path.join(fakeHome, '.second-brain', 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        wiredRepos: Record<string, { namespace: string }>;
      };
      const entry = Object.values(config.wiredRepos)[0];
      expect(entry.namespace).toBe('myproj');

      await runUnwire({ repo: tmpDir });
      const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        wiredRepos: Record<string, unknown>;
      };
      expect(Object.keys(after.wiredRepos)).toHaveLength(0);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('warns and falls back to personal when no project namespace is set', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-home-ns-'));
    try {
      swapHome(fakeHome);
      const { runWire } = await import('../wire.js');
      const result = await runWire({
        repo: tmpDir,
        installClaudeSession: false,
      });
      expect(result.namespace).toBe('personal');
      expect(result.warnings.some((w) => w.includes('no project namespace'))).toBe(true);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--require-project hard-fails when no project namespace is set', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-home-req-'));
    try {
      swapHome(fakeHome);
      const { runWire } = await import('../wire.js');
      await expect(
        runWire({ repo: tmpDir, installClaudeSession: false, requireProject: true }),
      ).rejects.toThrow(/no project namespace set/);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
