/**
 * T5 — the post-* git hooks installed by `brain wire` must NOT emit an
 * `author` block when `git config user.email` is unset. The server's
 * `AuthorSchema` requires `.email()`; the surrounding field on
 * `GitEventSchema.author` is `.optional()`, so omitting the block is the
 * correct on-the-wire shape.
 *
 * Strategy:
 *   1. Static assertions on the rendered hook script — the conditional
 *      `if [ -n "$EMAIL" ]` must wrap the author field.
 *   2. End-to-end shell execution — run the hook with a `curl` shim on PATH
 *      that captures the request body, and assert the body has (or omits)
 *      `"author"` based on whether `user.email` is configured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { installGitHooks, GIT_HOOK_NAMES } from '../install-git-hooks.js';

let tmpDir: string;

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hook-author-'));
  git(['init', '-q', '-b', 'main'], tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a `curl` shim into `binDir` that records every `-d <body>` argument
 * to `outFile` (one line per invocation) and exits 0. The shim is a tiny
 * shell script — no Node dependency at hook runtime.
 */
function writeCurlShim(binDir: string, outFile: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const shim = [
    '#!/bin/sh',
    '# Test shim: write the JSON body following `-d` to a file.',
    `OUT=${JSON.stringify(outFile)}`,
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -d)',
    '      shift',
    '      printf "%s\\n" "$1" >> "$OUT"',
    '      ;;',
    '  esac',
    '  shift',
    'done',
    'exit 0',
    '',
  ].join('\n');
  const shimPath = path.join(binDir, 'curl');
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });
}

describe('git hook template — author block is conditional on user.email', () => {
  it('renders an `if [ -n "$EMAIL" ]` conditional around the author field', () => {
    installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
    });
    for (const name of GIT_HOOK_NAMES) {
      const hookPath = path.join(tmpDir, '.git', 'hooks', name);
      const body = fs.readFileSync(hookPath, 'utf8');
      // Conditional wrapper present.
      expect(body).toContain('AUTHOR_FIELD=""');
      expect(body).toContain('if [ -n "$EMAIL" ]; then');
      // The author block is no longer an unconditional JSON literal.
      // (The conditional assignment is the only place "author" appears.)
      expect(body).not.toMatch(/^\s*"author":\s*\{\s*"canonicalEmail"/m);
      // The conditional value contains the canonicalEmail field, escaped.
      expect(body).toContain('\\"author\\":');
      expect(body).toContain('\\"canonicalEmail\\":');
      // The field is inlined into the JSON body via $AUTHOR_FIELD.
      expect(body).toContain('"$(date -u +%Y-%m-%dT%H:%M:%SZ)"$AUTHOR_FIELD');
    }
  });

  it('runtime: post-commit with empty user.email omits the author key', { timeout: 20000 }, () => {
    installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
    });

    const binDir = path.join(tmpDir, 'fake-bin');
    const outFile = path.join(tmpDir, 'curl-body.log');
    writeCurlShim(binDir, outFile);

    // Set a name but NO email — reproduces the bug.
    git(['config', 'user.name', 'NoEmail Tester'], tmpDir);
    // Defensive: ensure no inherited email leaks in.
    try {
      git(['config', '--unset', 'user.email'], tmpDir);
    } catch {
      // already unset
    }

    // Stage a file so commit has content.
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n');
    git(['add', '.'], tmpDir);

    // PATH-prepend the shim. We also force-empty user.email at command level
    // and override GIT_AUTHOR_EMAIL/GIT_COMMITTER_EMAIL so git itself accepts
    // the commit (older git refuses to commit without an author identity).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GIT_AUTHOR_NAME: 'NoEmail Tester',
      GIT_COMMITTER_NAME: 'NoEmail Tester',
      GIT_AUTHOR_EMAIL: ' ', // git requires non-empty for the commit identity
      GIT_COMMITTER_EMAIL: ' ',
    };

    // Use spawnSync — execFileSync would throw on non-zero, but git's hook
    // exits 0 via `|| true` so it shouldn't anyway.
    const res = spawnSync(
      'git',
      ['-c', 'user.email=', 'commit', '-q', '-m', 'no email'],
      { cwd: tmpDir, env, encoding: 'utf8' },
    );
    // Commit must have succeeded.
    expect(res.status).toBe(0);

    // The shim should have written at least one body.
    expect(fs.existsSync(outFile)).toBe(true);
    const body = fs.readFileSync(outFile, 'utf8');
    expect(body.trim().length).toBeGreaterThan(0);
    // The single critical assertion: no author key in the JSON body.
    expect(body).not.toContain('"author"');
    expect(body).not.toContain('canonicalEmail');
  });

  it('runtime: post-commit with a valid user.email DOES include the author block', { timeout: 20000 }, () => {
    installGitHooks({
      repoRoot: tmpDir,
      serverUrl: 'http://localhost:7430',
      namespace: 'proj',
    });

    const binDir = path.join(tmpDir, 'fake-bin');
    const outFile = path.join(tmpDir, 'curl-body.log');
    writeCurlShim(binDir, outFile);

    git(['config', 'user.email', 'test@example.com'], tmpDir);
    git(['config', 'user.name', 'Test User'], tmpDir);

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n');
    git(['add', '.'], tmpDir);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };
    const res = spawnSync('git', ['commit', '-q', '-m', 'with email'], {
      cwd: tmpDir,
      env,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    const body = fs.readFileSync(outFile, 'utf8');
    expect(body).toContain('"author"');
    expect(body).toContain('"canonicalEmail":"test@example.com"');
    expect(body).toContain('"displayName":"Test User"');
    expect(body).toContain('"aliases":[]');
  });
});
