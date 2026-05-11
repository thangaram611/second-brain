import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '@second-brain/core';
import { HookContextCache, hashRouteInput } from '../services/hook-context-cache.js';
import { HookContextRouter } from '../services/hook-context-router.js';

let brain: Brain | null = null;
let cache: HookContextCache;
let router: HookContextRouter;
const NAMESPACE = 'test-ns';

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  cache = new HookContextCache();
  router = new HookContextRouter(cache);
});

afterEach(() => {
  brain?.close();
  brain = null;
});

function getBrain(): Brain {
  if (!brain) throw new Error('brain not initialized');
  return brain;
}

function seedFileEntity(path: string): string {
  const entity = getBrain().entities.create({
    type: 'file',
    name: path,
    namespace: NAMESPACE,
    observations: ['contains login form', 'authored by alice'],
    properties: { path },
    source: { type: 'conversation', ref: path },
    tags: ['file'],
  });
  return entity.id;
}

function seedDecision(name: string, observations: string[] = []): string {
  const e = getBrain().entities.create({
    type: 'decision',
    name,
    namespace: NAMESPACE,
    observations,
    source: { type: 'conversation' },
  });
  return e.id;
}

describe('HookContextRouter', () => {
  describe('Read tool', () => {
    it('returns block citing entity when file is in graph', async () => {
      const filePath = '/repo/src/auth.ts';
      seedFileEntity(filePath);

      const res = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: filePath },
        cwd: '/repo',
        sessionId: 's-read',
        namespace: NAMESPACE,
        brain: getBrain(),
      });

      expect(res.contextBlock).not.toBeNull();
      expect(res.contextBlock).toContain(filePath);
      expect(res.contextBlock).toContain('contains login form');
      expect(res.cacheKey).toContain('s-read:Read:');
    });

    it('returns null for unknown file (no entity, no parallel work)', async () => {
      const res = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: '/repo/unknown.ts' },
        cwd: '/repo',
        sessionId: 's-read-empty',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
    });
  });

  describe('Edit/Write/MultiEdit', () => {
    it('searches for symbol mentions on Edit', async () => {
      // Seed an entity whose name will match the symbol token we extract.
      seedDecision('bcryptHelper', ['Use bcrypt for password hashing']);

      const res = await router.routeContext({
        toolName: 'Edit',
        toolInput: {
          file_path: '/repo/src/auth-utils.ts',
          // First [A-Za-z_]\w{2,}+ token is "bcryptHelper".
          new_string: 'bcryptHelper(input)',
        },
        cwd: '/repo',
        sessionId: 's-edit',
        namespace: NAMESPACE,
        brain: getBrain(),
      });

      expect(res.contextBlock).not.toBeNull();
      expect(res.contextBlock?.toLowerCase()).toContain('bcrypt');
    });

    it('handles MultiEdit input shape', async () => {
      seedFileEntity('/repo/src/foo.ts');
      seedDecision('Foo handler decision');

      const res = await router.routeContext({
        toolName: 'MultiEdit',
        toolInput: {
          file_path: '/repo/src/foo.ts',
          edits: [
            { old_string: 'fooHandler()', new_string: 'fooHandler({ scope: "all" })' },
          ],
        },
        cwd: '/repo',
        sessionId: 's-multi',
        namespace: NAMESPACE,
        brain: getBrain(),
      });

      expect(res.contextBlock).not.toBeNull();
    });
  });

  describe('Bash', () => {
    it('searches by first-token tag for known tools', async () => {
      seedDecision('git', ['Use squash-merge by default']);

      const res = await router.routeContext({
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        cwd: '/repo',
        sessionId: 's-bash',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).not.toBeNull();
      expect(res.contextBlock).toContain('squash-merge');
    });

    it('returns null for unknown shell tool', async () => {
      const res = await router.routeContext({
        toolName: 'Bash',
        toolInput: { command: 'awk "/foo/" file.txt' },
        cwd: '/repo',
        sessionId: 's-bash-unk',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
    });
  });

  describe('Grep/Glob', () => {
    it('returns block when pattern matches an entity name (FTS)', async () => {
      seedDecision('AuthMiddleware redesign');

      const res = await router.routeContext({
        toolName: 'Grep',
        toolInput: { pattern: 'AuthMiddleware' },
        cwd: '/repo',
        sessionId: 's-grep',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).not.toBeNull();
      expect(res.contextBlock).toContain('AuthMiddleware');
    });

    it('returns null when pattern matches nothing', async () => {
      const res = await router.routeContext({
        toolName: 'Glob',
        toolInput: { pattern: 'nonexistent_thing_xyz' },
        cwd: '/repo',
        sessionId: 's-glob-empty',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
    });

    it('returns null for very short patterns (<3 chars)', async () => {
      const res = await router.routeContext({
        toolName: 'Grep',
        toolInput: { pattern: 'ab' },
        cwd: '/repo',
        sessionId: 's-grep-short',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
    });
  });

  describe('mcp tools', () => {
    it('returns null for any mcp__second-brain__* tool', async () => {
      seedDecision('Some decision');
      const res = await router.routeContext({
        toolName: 'mcp__second-brain__search_brain',
        toolInput: { query: 'decision' },
        cwd: '/repo',
        sessionId: 's-mcp',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
      expect(res.cacheKey).toContain('mcp-suppressed');
    });
  });

  describe('prompt-submit', () => {
    it('returns block from buildRecallContextBlock for sufficient prompts', async () => {
      seedDecision('Postgres schema change', [
        'Postgres replaces MongoDB for relational data in service tier',
      ]);

      // FTS uses implicit AND across tokens; pick a prompt whose every token
      // appears in the seeded decision body.
      const res = await router.routeContext({
        toolName: 'prompt-submit',
        toolInput: { prompt: 'Postgres schema change for service tier data' },
        cwd: '/repo',
        sessionId: 's-prompt',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).not.toBeNull();
      expect(res.contextBlock).toContain('Postgres');
    });

    it('returns null for prompts shorter than 12 chars', async () => {
      const res = await router.routeContext({
        toolName: 'prompt-submit',
        toolInput: { prompt: 'short' },
        cwd: '/repo',
        sessionId: 's-prompt-short',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
    });
  });

  describe('quiet-mode paths', () => {
    it.each([
      'node_modules/foo/index.js',
      '/repo/node_modules/x.js',
      'dist/main.js',
      '.git/HEAD',
      'package-lock.json',
      '/repo/package-lock.json',
      'pnpm-lock.yaml',
      '.next/cache/index.js',
    ])('returns null for quiet path %s', async (path) => {
      seedFileEntity(path);
      const res = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: path },
        cwd: '/repo',
        sessionId: 's-quiet',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
    });
  });

  describe('dedup cache (30s)', () => {
    it('returns null on second invocation with same input', async () => {
      const filePath = '/repo/src/dedup.ts';
      seedFileEntity(filePath);

      const first = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: filePath },
        cwd: '/repo',
        sessionId: 's-dedup',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(first.contextBlock).not.toBeNull();

      const second = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: filePath },
        cwd: '/repo',
        sessionId: 's-dedup',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(second.contextBlock).toBeNull();
      expect(second.cacheKey).toBe(first.cacheKey);
    });

    it('canonicalizes input — different key order produces same hash', () => {
      const a = hashRouteInput('Read', { file_path: '/x', limit: 5 });
      const b = hashRouteInput('Read', { limit: 5, file_path: '/x' });
      expect(a).toBe(b);
    });
  });

  describe('hard caps', () => {
    it('truncates blocks larger than 4KB', async () => {
      const filePath = '/repo/src/big.ts';
      const huge = 'x'.repeat(5000);
      getBrain().entities.create({
        type: 'file',
        name: filePath,
        namespace: NAMESPACE,
        observations: [huge, huge, huge, huge, huge],
        properties: { path: filePath },
        source: { type: 'conversation', ref: filePath },
        tags: ['file'],
      });

      const res = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: filePath },
        cwd: '/repo',
        sessionId: 's-cap',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).not.toBeNull();
      const bytes = Buffer.byteLength(res.contextBlock ?? '', 'utf8');
      expect(bytes).toBeLessThanOrEqual(4 * 1024);
    });

    it('caps cumulative session bytes at 32KB then returns null', async () => {
      // Manually inflate the per-session counter past the cap.
      cache.addSessionBytes('s-cum', 32 * 1024);

      seedFileEntity('/repo/src/anywhere.ts');
      const res = await router.routeContext({
        toolName: 'Read',
        toolInput: { file_path: '/repo/src/anywhere.ts' },
        cwd: '/repo',
        sessionId: 's-cum',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).toBeNull();
      expect(res.cacheKey).toContain('cap-hit');
    });

    it('caps cited entities at 8 even when many match', async () => {
      // Seed 12 decisions matching the same FTS query.
      for (let i = 0; i < 12; i++) {
        seedDecision(`Bcrypt rule ${i}`, ['relates to bcrypt hashing']);
      }
      const res = await router.routeContext({
        toolName: 'Edit',
        toolInput: {
          file_path: '/repo/src/auth.ts',
          new_string: 'bcrypt.hashSync(pwd, 10);',
        },
        cwd: '/repo',
        sessionId: 's-cap-entities',
        namespace: NAMESPACE,
        brain: getBrain(),
      });
      expect(res.contextBlock).not.toBeNull();
      // Each cited entity contributes a `· ns=` line.
      const cited = (res.contextBlock?.match(/· ns=/g) ?? []).length;
      expect(cited).toBeLessThanOrEqual(8);
    });
  });

  describe('cwd fallback (sessionId → cwd cache)', () => {
    it('uses cached cwd when payload omits it', async () => {
      cache.setCwd('s-fallback', '/cached/cwd');
      // The cwd resolution lives in observation-service; but the router doesn't
      // hard-fail on empty cwd today (every per-tool route is namespace-scoped).
      // This test verifies the cache itself is the auxiliary data source.
      expect(cache.getCwd('s-fallback')).toBe('/cached/cwd');
    });
  });

  describe('cache key shape', () => {
    it('produces a stable cache key per (session, tool, input)', () => {
      const k1 = cache.blockCacheKey('s', 'Read', { file_path: '/x' });
      const k2 = cache.blockCacheKey('s', 'Read', { file_path: '/x' });
      expect(k1).toBe(k2);
      const k3 = cache.blockCacheKey('s', 'Read', { file_path: '/y' });
      expect(k3).not.toBe(k1);
    });
  });

  describe('relative-path normalization (PR6.2)', () => {
    describe('Read', () => {
      it('resolves relative tool-arg path against input.cwd', async () => {
        // Entity is keyed by absolute path; tool sends a relative one.
        const absolute = '/repo/src/auth.ts';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: 'src/auth.ts' },
          cwd: '/repo',
          sessionId: 's-rel-read',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
        expect(res.contextBlock).toContain('contains login form');
      });

      it('skips injection when path is relative and cwd is empty', async () => {
        // Even though the absolute path matches an entity, the empty cwd means
        // we cannot anchor the relative ref — return null rather than guess.
        seedFileEntity('/repo/src/auth.ts');

        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: 'src/auth.ts' },
          cwd: '',
          sessionId: 's-rel-no-cwd',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).toBeNull();
      });

      it('absolute path is unchanged (regression)', async () => {
        const absolute = '/repo/src/auth.ts';
        seedFileEntity(absolute);

        // Pass a misleading cwd; abs path must NOT be re-resolved against it.
        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: absolute },
          cwd: '/somewhere/else',
          sessionId: 's-abs-read',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });
    });

    describe('Bash', () => {
      it('normalizes relative path in cat command against cwd', async () => {
        const absolute = '/repo/src/auth.ts';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'cat src/auth.ts' },
          cwd: '/repo',
          sessionId: 's-bash-rel',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
        expect(res.contextBlock).toContain('contains login form');
      });

      it('absolute path in cat command is unchanged', async () => {
        const absolute = '/repo/src/auth.ts';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: `cat ${absolute}` },
          cwd: '/wrong/cwd',
          sessionId: 's-bash-abs',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('handles grep PATTERN <path> shape (skips pattern, normalizes path)', async () => {
        const absolute = '/repo/src/login.ts';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'grep -i loginForm src/login.ts' },
          cwd: '/repo',
          sessionId: 's-bash-grep-rel',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('relative path with empty cwd → falls through to BASH_TAG_TOOLS path', async () => {
        // `cat foo.ts` with empty cwd: normalization yields null, so we fall
        // through. `cat` is not in BASH_TAG_TOOLS, so the final result is null.
        seedFileEntity('/repo/src/foo.ts');

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'cat src/foo.ts' },
          cwd: '',
          sessionId: 's-bash-rel-no-cwd',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).toBeNull();
      });
    });

    describe('Grep/Glob', () => {
      it('normalizes a relative search-root path against cwd', async () => {
        seedDecision('AuthMiddleware redesign');

        const res = await router.routeContext({
          toolName: 'Grep',
          toolInput: { pattern: 'AuthMiddleware', path: 'src' },
          cwd: '/repo',
          sessionId: 's-grep-rel-root',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        // Pattern matches the seeded entity; root just colors the heading.
        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain('/repo/src');
        expect(res.contextBlock).toContain('AuthMiddleware');
      });

      it('relative root with empty cwd → returns null (no guess)', async () => {
        seedDecision('AuthMiddleware redesign');

        const res = await router.routeContext({
          toolName: 'Grep',
          toolInput: { pattern: 'AuthMiddleware', path: 'src' },
          cwd: '',
          sessionId: 's-grep-rel-no-cwd',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).toBeNull();
      });

      it('absolute root is unchanged', async () => {
        seedDecision('AuthMiddleware redesign');

        const res = await router.routeContext({
          toolName: 'Grep',
          toolInput: { pattern: 'AuthMiddleware', path: '/repo/src' },
          cwd: '/wrong/cwd',
          sessionId: 's-grep-abs-root',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain('/repo/src');
      });

      it('no path arg → behaves like before (no normalization needed)', async () => {
        seedDecision('AuthMiddleware redesign');

        const res = await router.routeContext({
          toolName: 'Grep',
          toolInput: { pattern: 'AuthMiddleware' },
          cwd: '',
          sessionId: 's-grep-no-path',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain('AuthMiddleware');
      });
    });

    describe('Bash flag-with-arg shapes (P2)', () => {
      it('handles `head -n 5 <relative-path>` — flag value is not the path', async () => {
        const absolute = '/repo/relative/file.txt';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'head -n 5 ./relative/file.txt' },
          cwd: '/repo',
          sessionId: 's-head-n5',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('handles `tail -c 1000 <relative-path>`', async () => {
        const absolute = '/repo/other.log';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'tail -c 1000 ./other.log' },
          cwd: '/repo',
          sessionId: 's-tail-c',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('handles `grep -m 5 PATTERN <relative-path>` — flag value AND pattern positional skipped', async () => {
        const absolute = '/repo/src/foo.ts';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'grep -m 5 PATTERN ./src/foo.ts' },
          cwd: '/repo',
          sessionId: 's-grep-m5',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('handles long-form `--lines=5` inline (no skip)', async () => {
        const absolute = '/repo/src/foo.ts';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'head --lines=5 ./src/foo.ts' },
          cwd: '/repo',
          sessionId: 's-head-long',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });
    });

    describe('Bash quoted-path shapes (P2)', () => {
      it('handles `cat "my file.txt"` — quoted path with embedded space', async () => {
        const absolute = '/repo/my file.txt';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'cat "my file.txt"' },
          cwd: '/repo',
          sessionId: 's-cat-quoted',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('handles single-quoted absolute path', async () => {
        const absolute = '/repo/my file.txt';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: "cat '/repo/my file.txt'" },
          cwd: '/wrong/cwd',
          sessionId: 's-cat-single-quoted',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('handles backslash-escaped space (`cat my\\ file.txt`)', async () => {
        const absolute = '/repo/my file.txt';
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'cat my\\ file.txt' },
          cwd: '/repo',
          sessionId: 's-cat-escaped',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });
    });

    describe('home-dir expansion (NIT)', () => {
      it('expands `~/` against os.homedir() (NOT under cwd)', async () => {
        const absolute = path.join(os.homedir(), 'foo.txt');
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: '~/foo.txt' },
          cwd: '/some/other/cwd',
          sessionId: 's-tilde',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
        // Defensive: must NOT have resolved against cwd.
        expect(res.contextBlock).not.toContain('/some/other/cwd/~/foo.txt');
      });

      it('expands `$HOME/` against os.homedir()', async () => {
        const absolute = path.join(os.homedir(), 'bar.txt');
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: '$HOME/bar.txt' },
          cwd: '/some/other/cwd',
          sessionId: 's-home-env',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('expands bare `~` to the home directory', async () => {
        const absolute = os.homedir();
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: '~' },
          cwd: '/wrong/cwd',
          sessionId: 's-bare-tilde',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });

      it('expands `~/` in Bash commands too', async () => {
        const absolute = path.join(os.homedir(), 'notes.md');
        seedFileEntity(absolute);

        const res = await router.routeContext({
          toolName: 'Bash',
          toolInput: { command: 'cat ~/notes.md' },
          cwd: '/repo',
          sessionId: 's-bash-tilde',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).not.toBeNull();
        expect(res.contextBlock).toContain(absolute);
      });
    });

    describe('defensive cwd handling (NIT)', () => {
      it('returns null when relative path is given but cwd is itself not absolute', async () => {
        seedFileEntity('/repo/src/foo.ts');

        const res = await router.routeContext({
          toolName: 'Read',
          toolInput: { file_path: 'src/foo.ts' },
          // Misconfigured upstream: relative cwd cannot anchor a relative path.
          cwd: 'relative/cwd',
          sessionId: 's-non-abs-cwd',
          namespace: NAMESPACE,
          brain: getBrain(),
        });

        expect(res.contextBlock).toBeNull();
      });
    });
  });
});
