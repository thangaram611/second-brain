/**
 * Repo-root discovery helpers, shared across `brain wire`/`unwire`/`sync`/
 * `doctor`/`init client`/`ownership`.
 *
 * Two intentionally-distinct contracts live here — do NOT collapse them onto a
 * single algorithm:
 *
 *  - {@link gitRepoRoot} (Algorithm A) — strict `git rev-parse --show-toplevel`,
 *    with an optional explicit override. Used by callers that need the true git
 *    toplevel (wire/unwire then assert `.git` and install git hooks; sync and
 *    ownership locate the repo from cwd).
 *  - {@link discoverRepoRoot} (Algorithm B) — a 32-level walk-up matching `.git`
 *    OR `.second-brain`. Used by `doctor` and `init client`, which must detect
 *    client-only boxes (a `.second-brain` dir with no `.git`) and, in tests,
 *    fake repo roots built with `mkdirSync(repoRoot/.git)` rather than real git.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitRepoRootOptions {
  /** Explicit repo root override. When set, returned verbatim via `path.resolve`. */
  explicit?: string;
  /** Working directory for `git rev-parse`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** When true, throw a friendly error instead of returning null on failure. */
  throwIfMissing?: boolean;
}

/**
 * Strict git-toplevel resolution (Algorithm A).
 *
 * Returns `path.resolve(explicit)` when an explicit root is given; otherwise
 * runs `git rev-parse --show-toplevel` from `cwd`. On empty output or a git
 * failure it returns null by default, or throws `not inside a git repository`
 * when `throwIfMissing` is set. The overloads narrow the return to `string`
 * when `throwIfMissing` is `true` so callers don't need a cast.
 */
export function gitRepoRoot(opts: GitRepoRootOptions & { throwIfMissing: true }): string;
export function gitRepoRoot(opts?: GitRepoRootOptions): string | null;
export function gitRepoRoot(opts: GitRepoRootOptions = {}): string | null {
  if (opts.explicit) return path.resolve(opts.explicit);
  const cwd = opts.cwd ?? process.cwd();
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) throw new Error('empty git rev-parse output');
    return path.resolve(out);
  } catch {
    if (opts.throwIfMissing) {
      throw new Error(`not inside a git repository (cwd=${cwd})`);
    }
    return null;
  }
}

/**
 * Walk-up discovery matching `.git` OR `.second-brain` (Algorithm B).
 *
 * Resolves `cwd` then climbs up to 32 levels, returning the first directory
 * containing a `.git` or `.second-brain` entry, or null when neither is found.
 */
export function discoverRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.second-brain'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
