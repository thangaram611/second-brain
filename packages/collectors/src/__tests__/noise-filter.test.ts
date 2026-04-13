import { describe, it, expect } from 'vitest';
import { filterNoise, isDeniedByGlobs, DEFAULT_DENY_DIRS, DEFAULT_DENY_GLOBS } from '../git-context/noise-filter.js';

describe('isDeniedByGlobs', () => {
  it('denies files in denylisted directories', () => {
    expect(isDeniedByGlobs('node_modules/foo/index.js', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(true);
    expect(isDeniedByGlobs('dist/app.js', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(true);
    expect(isDeniedByGlobs('.git/HEAD', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(true);
  });

  it('denies files by suffix glob', () => {
    expect(isDeniedByGlobs('packages/foo/yarn.lock', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(true);
    expect(isDeniedByGlobs('snapshot/__snapshots__/Foo.test.ts.snap', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(true);
    expect(isDeniedByGlobs('.DS_Store', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(true);
  });

  it('allows normal source files', () => {
    expect(isDeniedByGlobs('packages/core/src/brain.ts', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(false);
    expect(isDeniedByGlobs('apps/server/src/app.ts', DEFAULT_DENY_GLOBS, DEFAULT_DENY_DIRS)).toBe(false);
  });
});

describe('filterNoise', () => {
  it('passes through non-noise changes when stabilityWait is 0', async () => {
    const out = await filterNoise(
      [
        { kind: 'change', path: 'packages/foo/bar.ts' },
        { kind: 'add', path: 'packages/foo/baz.ts' },
      ],
      { repoRoot: '/tmp/fake', stabilityWaitMs: 0 },
    );
    expect(out).toHaveLength(2);
  });

  it('drops lockfile + node_modules changes', async () => {
    const out = await filterNoise(
      [
        { kind: 'change', path: 'pnpm-lock.yaml' },
        { kind: 'change', path: 'node_modules/foo/index.js' },
        { kind: 'change', path: 'src/real.ts' },
      ],
      { repoRoot: '/tmp/fake', stabilityWaitMs: 0 },
    );
    expect(out.map((c) => c.path)).toEqual(['src/real.ts']);
  });

  it('drops unstable writes (size+mtime changed during stability wait)', async () => {
    let call = 0;
    const out = await filterNoise(
      [{ kind: 'change', path: 'src/flicker.ts' }],
      {
        repoRoot: '/tmp/fake',
        stabilityWaitMs: 5,
        statFn: async () => {
          call++;
          // First call = initial stat; second call = post-wait stat. Simulate
          // formatter flicker by changing both size and mtime between calls.
          return call === 1
            ? { size: 100, mtimeMs: 1_000_000 }
            : { size: 250, mtimeMs: 1_000_500 };
        },
      },
    );
    expect(out).toHaveLength(0);
  });

  it('keeps stable writes (size+mtime unchanged during wait)', async () => {
    const out = await filterNoise(
      [{ kind: 'change', path: 'src/stable.ts' }],
      {
        repoRoot: '/tmp/fake',
        stabilityWaitMs: 5,
        statFn: async () => ({ size: 100, mtimeMs: 1_000_000 }),
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('src/stable.ts');
  });

  it('passes unlink events through without stability check', async () => {
    const out = await filterNoise(
      [{ kind: 'unlink', path: 'src/deleted.ts' }],
      { repoRoot: '/tmp/fake', stabilityWaitMs: 500 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('unlink');
  });

  it('respects extraDenyGlobs', async () => {
    const out = await filterNoise(
      [
        { kind: 'change', path: 'app.generated.ts' },
        { kind: 'change', path: 'app.ts' },
      ],
      {
        repoRoot: '/tmp/fake',
        stabilityWaitMs: 0,
        extraDenyGlobs: ['*.generated.ts'],
      },
    );
    expect(out.map((c) => c.path)).toEqual(['app.ts']);
  });
});
