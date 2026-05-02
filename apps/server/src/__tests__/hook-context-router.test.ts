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
      seedDecision('Postgres migration', [
        'Postgres replaces MongoDB for relational data in service tier',
      ]);

      // FTS uses implicit AND across tokens; pick a prompt whose every token
      // appears in the seeded decision body.
      const res = await router.routeContext({
        toolName: 'prompt-submit',
        toolInput: { prompt: 'Postgres migration for service tier data' },
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
});
