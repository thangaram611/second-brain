import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WatchChange } from '../watch/watcher.js';

/**
 * Glob-like suffix denylist. Kept as simple globs rather than a regex so the
 * set is readable and users can extend via NoiseFilterOptions.extraDenyGlobs.
 */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
  '*.lock',
  '*.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'Cargo.lock',
  'Pipfile.lock',
  '*.snap',
  '.DS_Store',
  '*.swp',
  '*~',
];

export const DEFAULT_DENY_DIRS: readonly string[] = [
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'node_modules',
  '.git',
  '.second-brain',
];

export interface NoiseFilterOptions {
  /** Repo root (absolute) — used to relativize paths for glob matching. */
  repoRoot: string;
  /** Additional glob suffixes to deny. */
  extraDenyGlobs?: readonly string[];
  /** Additional directory names to deny. */
  extraDenyDirs?: readonly string[];
  /** Content-stability wait in ms. Defaults to 3000. Set 0 to disable. */
  stabilityWaitMs?: number;
  /** Override for `fs.stat`, for testability. */
  statFn?: (p: string) => Promise<{ size: number; mtimeMs: number } | null>;
}

function matchGlob(glob: string, name: string): boolean {
  // Only supports leading-star or exact match — everything we need for a
  // denylist without pulling in micromatch. Full glob syntax is overkill.
  if (glob.startsWith('*')) return name.endsWith(glob.slice(1));
  return name === glob;
}

export function isDeniedByGlobs(
  relPath: string,
  denyGlobs: readonly string[],
  denyDirs: readonly string[],
): boolean {
  const parts = relPath.split(/[\\/]/);
  for (const part of parts) {
    if (denyDirs.includes(part)) return true;
  }
  const name = parts[parts.length - 1] ?? '';
  for (const glob of denyGlobs) {
    if (matchGlob(glob, name)) return true;
  }
  return false;
}

async function defaultStat(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await fs.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Filter a batch of watch events down to those worth persisting. Steps:
 *   1. glob denylist removes lockfiles, build output, node_modules, etc.
 *   2. content-stability check — wait N ms, re-stat, keep only events whose
 *      size+mtime didn't change (formatter flicker rewrites files twice
 *      within the debounce window; this drops the transient write).
 *
 * `unlink` events skip the stability check — a deleted file can't be restated.
 */
export async function filterNoise(
  changes: ReadonlyArray<WatchChange>,
  options: NoiseFilterOptions,
): Promise<WatchChange[]> {
  const denyGlobs = [...DEFAULT_DENY_GLOBS, ...(options.extraDenyGlobs ?? [])];
  const denyDirs = [...DEFAULT_DENY_DIRS, ...(options.extraDenyDirs ?? [])];
  const stat = options.statFn ?? defaultStat;
  const waitMs = options.stabilityWaitMs ?? 3000;

  const keep: WatchChange[] = [];
  const candidates: Array<{
    change: WatchChange;
    initial: { size: number; mtimeMs: number };
  }> = [];

  for (const change of changes) {
    const relPath = path.isAbsolute(change.path)
      ? path.relative(options.repoRoot, change.path)
      : change.path;
    if (isDeniedByGlobs(relPath, denyGlobs, denyDirs)) continue;

    if (change.kind === 'unlink' || waitMs === 0) {
      keep.push(change);
      continue;
    }
    const absPath = path.isAbsolute(change.path)
      ? change.path
      : path.join(options.repoRoot, change.path);
    const initial = await stat(absPath);
    if (!initial) {
      // File disappeared between event and stat — treat as unlink dropped by
      // stability; drop from output (next real event will re-surface).
      continue;
    }
    candidates.push({ change, initial });
  }

  if (waitMs > 0 && candidates.length > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
    for (const { change, initial } of candidates) {
      const absPath = path.isAbsolute(change.path)
        ? change.path
        : path.join(options.repoRoot, change.path);
      const after = await stat(absPath);
      if (!after) continue; // File gone — skip
      if (after.size === initial.size && after.mtimeMs === initial.mtimeMs) {
        keep.push(change);
      }
      // else: still churning — drop; the next real event will fire this round.
    }
  }

  return keep;
}
