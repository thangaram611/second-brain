/**
 * PR6 §6.3 — `/api/query/ownership*` namespace scoping.
 *
 * The ownership service joins the entities table to look up review signals
 * (merge_request / pull_request entities that touch a given file path). Before
 * PR6.3 the join had no namespace dimension, so a query in namespace A could
 * leak signals from MRs in namespace B that happened to touch a path with the
 * same name. These tests pin the fix down end-to-end:
 *   1. Cross-namespace ownership query returns ONLY same-namespace signals.
 *   2. ownership-tree recursion threads the namespace through every depth.
 *   3. An unbound PAT calling `/api/query/ownership` without `?namespace=`
 *      receives a 400 namespace-required (the route layer short-circuits before
 *      the service runs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { Brain } from '@second-brain/core';
import { createApp } from '../app.js';
import { OwnershipService } from '../services/ownership-service.js';
import { UsersService, generateUserId } from '../services/users.js';

const INVITE_KEY = 'invite-key-ownership-ns';

function makeOwnershipService(brain: Brain, repoRoot: string): OwnershipService {
  return new OwnershipService(brain, {
    repoRoot,
    simpleGit: () => ({
      // Empty git history so the *only* signal source is review-relations
      // from the brain — that's what the namespace fix actually scopes.
      async log(): Promise<string> {
        return '';
      },
      async blame(): Promise<string> {
        return '';
      },
    }),
  });
}

function seedReviewSignal(
  brain: Brain,
  opts: { namespace: string; path: string; reviewerEmail: string; reviewerName: string },
): void {
  // Reviewer entity (the relation's target). The query reads its
  // properties.email / name back to label the review credit.
  const reviewer = brain.entities.create({
    type: 'person',
    name: opts.reviewerName,
    namespace: opts.namespace,
    source: { type: 'manual' },
    properties: { email: opts.reviewerEmail },
  });

  // Merge-request entity holding the touches_file marker — the LIKE clause
  // matches `%<path>%` against this.
  const mr = brain.entities.create({
    type: 'merge_request',
    name: `MR for ${opts.path}`,
    namespace: opts.namespace,
    source: { type: 'manual' },
    properties: { touches_file: opts.path },
  });

  brain.relations.create({
    type: 'reviewed_by',
    sourceId: mr.id,
    targetId: reviewer.id,
    namespace: opts.namespace,
    source: { type: 'manual' },
  });
}

describe('ownership-service — namespace scoping', () => {
  let brain: Brain;
  let app: Express;

  beforeEach(() => {
    brain = new Brain({ path: ':memory:', wal: false });
    const ownership = makeOwnershipService(brain, '/fake/repo');
    app = createApp(brain, { ownership });
  });

  afterEach(() => {
    brain.close();
  });

  it('cross-namespace query returns only same-namespace review signals', async () => {
    // Same path indexed with different reviewers in two namespaces.
    seedReviewSignal(brain, {
      namespace: 'alpha',
      path: 'src/feature.ts',
      reviewerEmail: 'alpha-reviewer@x.test',
      reviewerName: 'Alpha Reviewer',
    });
    seedReviewSignal(brain, {
      namespace: 'beta',
      path: 'src/feature.ts',
      reviewerEmail: 'beta-reviewer@x.test',
      reviewerName: 'Beta Reviewer',
    });

    const resAlpha = await request(app)
      .get('/api/query/ownership')
      .query({ path: 'src/feature.ts', namespace: 'alpha' })
      .expect(200);
    const actorsAlpha: string[] = resAlpha.body.map(
      (s: { actor: string }) => s.actor,
    );
    expect(actorsAlpha).toContain('alpha-reviewer@x.test');
    expect(actorsAlpha).not.toContain('beta-reviewer@x.test');

    const resBeta = await request(app)
      .get('/api/query/ownership')
      .query({ path: 'src/feature.ts', namespace: 'beta' })
      .expect(200);
    const actorsBeta: string[] = resBeta.body.map((s: { actor: string }) => s.actor);
    expect(actorsBeta).toContain('beta-reviewer@x.test');
    expect(actorsBeta).not.toContain('alpha-reviewer@x.test');
  });

  it('cache key includes namespace — same path in two namespaces stays distinct', async () => {
    // Direct service-level test (no HTTP) to prove the cache key actually
    // includes namespace; if it didn't, the second call would return the
    // cached alpha result.
    const ownership = makeOwnershipService(brain, '/fake/repo');

    seedReviewSignal(brain, {
      namespace: 'alpha',
      path: 'src/cache-test.ts',
      reviewerEmail: 'alpha@x.test',
      reviewerName: 'Alpha',
    });
    seedReviewSignal(brain, {
      namespace: 'beta',
      path: 'src/cache-test.ts',
      reviewerEmail: 'beta@x.test',
      reviewerName: 'Beta',
    });

    const alphaResult = await ownership.query({
      path: 'src/cache-test.ts',
      namespace: 'alpha',
    });
    const betaResult = await ownership.query({
      path: 'src/cache-test.ts',
      namespace: 'beta',
    });

    expect(alphaResult.map((r) => r.actor)).toEqual(['alpha@x.test']);
    expect(betaResult.map((r) => r.actor)).toEqual(['beta@x.test']);
  });
});

describe('ownership-tree route — namespace threading', () => {
  let brain: Brain;
  let app: Express;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-ns-tree-'));
    // Build a small file tree so buildOwnershipTree has something to walk.
    fs.mkdirSync(path.join(tmpRoot, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), '// a\n');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'nested', 'b.ts'), '// b\n');

    brain = new Brain({ path: ':memory:', wal: false });
    const ownership = makeOwnershipService(brain, tmpRoot);
    app = createApp(brain, { ownership });
  });

  afterEach(() => {
    brain.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves namespace at every depth — deep file owners are namespace-scoped', async () => {
    // Reviewer in alpha touches the deeply-nested file; reviewer in beta
    // touches a path with the same basename suffix in a different namespace.
    seedReviewSignal(brain, {
      namespace: 'alpha',
      path: 'src/nested/b.ts',
      reviewerEmail: 'alpha-deep@x.test',
      reviewerName: 'Alpha Deep',
    });
    seedReviewSignal(brain, {
      namespace: 'beta',
      path: 'src/nested/b.ts',
      reviewerEmail: 'beta-deep@x.test',
      reviewerName: 'Beta Deep',
    });

    const res = await request(app)
      .get('/api/query/ownership-tree')
      .query({ path: '.', namespace: 'alpha', depth: 3 })
      .expect(200);

    // Walk the tree to find the leaf at src/nested/b.ts.
    interface Node {
      path: string;
      isDir: boolean;
      owners?: Array<{ actor: string }>;
      children?: Node[];
    }
    function find(node: Node, target: string): Node | null {
      if (node.path === target) return node;
      for (const c of node.children ?? []) {
        const hit = find(c, target);
        if (hit) return hit;
      }
      return null;
    }
    const leaf = find(res.body, 'src/nested/b.ts');
    expect(leaf).not.toBeNull();
    const actors = (leaf?.owners ?? []).map((o) => o.actor);
    expect(actors).toContain('alpha-deep@x.test');
    expect(actors).not.toContain('beta-deep@x.test');
  });
});

describe('ownership route — unbound-token namespace requirement', () => {
  let brain: Brain;
  let users: UsersService;
  let app: Express;

  beforeEach(() => {
    brain = new Brain({ path: ':memory:', wal: false });
    users = new UsersService({ path: ':memory:' });
    const ownership = makeOwnershipService(brain, '/fake/repo');
    app = createApp(brain, {
      ownership,
      auth: {
        mode: 'pat',
        users,
        inviteSigningKey: INVITE_KEY,
        secureCookies: false,
      },
    });
  });

  afterEach(() => {
    brain.close();
    users.close();
  });

  it('returns 400 namespace-required when an unbound PAT omits ?namespace=', async () => {
    const u = users.createUser({
      id: generateUserId(),
      email: 'unbound-ownership@x.test',
      role: 'member',
    });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'beta', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read'],
      namespace: null, // unbound
    });

    const res = await request(app)
      .get('/api/query/ownership')
      .query({ path: 'src/anything.ts' })
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('namespace-required');
  });

  it('a token-locked PAT skips the namespace param and reuses the lock', async () => {
    const u = users.createUser({
      id: generateUserId(),
      email: 'locked-ownership@x.test',
      role: 'member',
    });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read'],
      namespace: 'alpha', // locked to alpha
    });

    seedReviewSignal(brain, {
      namespace: 'alpha',
      path: 'src/locked.ts',
      reviewerEmail: 'alpha-only@x.test',
      reviewerName: 'Alpha Only',
    });
    seedReviewSignal(brain, {
      namespace: 'beta',
      path: 'src/locked.ts',
      reviewerEmail: 'beta-bleed@x.test',
      reviewerName: 'Beta Bleed',
    });

    const res = await request(app)
      .get('/api/query/ownership')
      .query({ path: 'src/locked.ts' })
      .set('Authorization', `Bearer ${minted.pat}`)
      .expect(200);
    const actors: string[] = res.body.map((s: { actor: string }) => s.actor);
    expect(actors).toContain('alpha-only@x.test');
    expect(actors).not.toContain('beta-bleed@x.test');
  });

  it('rejects a locked-PAT request that explicitly asks for the wrong namespace', async () => {
    const u = users.createUser({
      id: generateUserId(),
      email: 'mismatch@x.test',
      role: 'member',
    });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read'],
      namespace: 'alpha',
    });

    const res = await request(app)
      .get('/api/query/ownership')
      .query({ path: 'src/x.ts', namespace: 'beta' })
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('namespace-mismatch');
  });
});
