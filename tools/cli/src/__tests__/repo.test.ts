import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitRepoRoot, discoverRepoRoot } from '../lib/repo.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-repo-test-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gitRepoRoot', () => {
  it('returns path.resolve(explicit) without shelling out to git', () => {
    const result = gitRepoRoot({ explicit: tmpDir, cwd: '/definitely/not/a/repo' });
    expect(result).toBe(path.resolve(tmpDir));
  });

  it('resolves the git toplevel from a nested cwd inside a git repo', () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
    const nested = path.join(tmpDir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const result = gitRepoRoot({ cwd: nested });
    expect(result).toBe(tmpDir);
  });

  it('returns null by default outside a git repo', () => {
    const result = gitRepoRoot({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it('throws when throwIfMissing is set outside a git repo', () => {
    expect(() => gitRepoRoot({ cwd: tmpDir, throwIfMissing: true })).toThrow(
      /not inside a git repository/,
    );
  });
});

describe('discoverRepoRoot', () => {
  it('finds a directory with only a .git entry', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    const nested = path.join(tmpDir, 'x', 'y');
    fs.mkdirSync(nested, { recursive: true });
    expect(discoverRepoRoot(nested)).toBe(tmpDir);
  });

  it('finds a directory with only a .second-brain entry (client-only box)', () => {
    fs.mkdirSync(path.join(tmpDir, '.second-brain'));
    expect(discoverRepoRoot(tmpDir)).toBe(tmpDir);
  });

  it('returns null when neither marker exists', () => {
    const nested = path.join(tmpDir, 'deep', 'path');
    fs.mkdirSync(nested, { recursive: true });
    expect(discoverRepoRoot(nested)).toBeNull();
  });
});
