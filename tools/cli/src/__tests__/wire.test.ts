import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  installGitHooks,
  uninstallGitHooks,
  GIT_HOOK_NAMES,
} from '../install-git-hooks.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const WiredConfigSchema = z.object({
  wiredRepos: z.record(z.string(), z.object({ namespace: z.string() }).passthrough()),
});

describe('installGitHooks / uninstallGitHooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-test-'));
    // installGitHooks only needs a `.git/hooks` directory to exist — it never
    // spawns git (the `git rev-parse` lines live inside the generated hook
    // text, not the installer). Creating the dir directly keeps these unit
    // tests subprocess-free, so they stay fast and deterministic even when the
    // whole workspace runs in parallel.
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes post-commit, post-merge, post-checkout scripts under .git/hooks', () => {
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
      expect(content).toContain('TOKEN="${SECOND_BRAIN_TOKEN:-${BRAIN_AUTH_TOKEN:-$WIRED_TOKEN}}"');
      expect(content).toContain('/api/observe/git-event');
      // Executable mode bit should be set.
      const mode = fs.statSync(hookPath).mode & 0o777;
      expect(mode & 0o100).toBeGreaterThan(0);
    }
    // Sidecar file exists
    expect(fs.existsSync(result.sidecarPath)).toBe(true);
  });

  it('honors an explicit bearer token in installed git hooks', () => {
    installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
      bearerToken: `sbp_token'with-quote`,
    });
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).toContain(`WIRED_TOKEN='sbp_token'\\''with-quote'`);
    expect(hook).toContain('-H "Authorization: Bearer $TOKEN"');
  });

  it('backs up a pre-existing user hook before overwriting', () => {
    const userHook = path.join(tmpDir, '.git', 'hooks', 'post-commit');
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

// These exercise the full runWire/runUnwire path, which needs a real git repo
// (gitRepoRoot + author resolution spawn git). The home directory is passed
// explicitly rather than swapping `process.env.HOME` — Node + vitest workers
// don't reliably propagate runtime HOME changes to `os.homedir()`. Real git
// subprocesses get a generous timeout so CPU contention under full-suite load
// can't trip the default 5s.
describe('runWire / runUnwire (integration)', () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-test-'));
    git(['init', '-q', '-b', 'main'], tmpDir);
    git(['config', 'user.email', 'test@example.com'], tmpDir);
    git(['config', 'user.name', 'Test'], tmpDir);
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('writes a wiredRepos entry into HOME/.second-brain/config.json', { timeout: 15_000 }, async () => {
    const { runWire } = await import('../wire.js');
    const { runUnwire } = await import('../unwire.js');

    const result = await runWire({
      repo: tmpDir,
      namespace: 'myproj',
      installAssistants: [],
      home: fakeHome,
    });
    expect(result.namespace).toBe('myproj');
    expect(result.gitHooks.installed.length).toBe(3);

    const configPath = path.join(fakeHome, '.second-brain', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = WiredConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    const entry = Object.values(config.wiredRepos)[0];
    expect(entry.namespace).toBe('myproj');

    await runUnwire({ repo: tmpDir, home: fakeHome });
    const after = WiredConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    expect(Object.keys(after.wiredRepos)).toHaveLength(0);
  });

  it('uses BRAIN_API_URL as the default hook server URL', { timeout: 15_000 }, async () => {
    const previous = process.env.BRAIN_API_URL;
    try {
      process.env.BRAIN_API_URL = 'http://brain.example.test:7430';
      const { runWire } = await import('../wire.js');

      await runWire({
        repo: tmpDir,
        namespace: 'myproj',
        installAssistants: [],
        home: fakeHome,
      });

      const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
      expect(hook).toContain("SERVER_URL='http://brain.example.test:7430'");
    } finally {
      if (previous === undefined) delete process.env.BRAIN_API_URL;
      else process.env.BRAIN_API_URL = previous;
    }
  });

  it('warns and falls back to personal when no project namespace is set', { timeout: 15_000 }, async () => {
    const { runWire } = await import('../wire.js');
    const result = await runWire({
      repo: tmpDir,
      installAssistants: [],
      home: fakeHome,
    });
    expect(result.namespace).toBe('personal');
    expect(result.warnings.some((w) => w.includes('no project namespace'))).toBe(true);
  });

  it('--require-project hard-fails when no project namespace is set', { timeout: 15_000 }, async () => {
    const { runWire } = await import('../wire.js');
    await expect(
      runWire({ repo: tmpDir, installAssistants: [], requireProject: true, home: fakeHome }),
    ).rejects.toThrow(/no project namespace set/);
  });
});
