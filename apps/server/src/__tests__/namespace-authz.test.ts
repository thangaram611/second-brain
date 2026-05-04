/**
 * Cross-namespace authorization on ID-based and path-param routes.
 *
 * Closes review gap: PAT bound to namespace A must not reach entities,
 * relations, or sync rooms in namespace B even when the request only carries
 * a resource ID (no body/query namespace for the middleware to inspect).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Brain } from '@second-brain/core';
import { SyncManager } from '@second-brain/sync';
import { createApp } from '../app.js';
import { UsersService, generateUserId } from '../services/users.js';

let brain: Brain;
let users: UsersService;
let syncManager: SyncManager;
let app: Express;

const INVITE_KEY = 'invite-key-test-123';

async function mintTokenLockedTo(namespace: string): Promise<{ pat: string }> {
  const u = users.createUser({ id: generateUserId(), email: `${namespace}@test`, role: 'member' });
  users.addNamespaceMembership({ userId: u.id, namespace, role: 'member' });
  const minted = await users.mintPat({
    userId: u.id,
    scopes: ['read', 'write'],
    namespace, // locked
  });
  return { pat: minted.pat };
}

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  users = new UsersService({ path: ':memory:' });
  syncManager = new SyncManager(brain.entities, brain.relations);
  app = createApp(brain, {
    syncManager,
    auth: {
      mode: 'pat',
      users,
      inviteSigningKey: INVITE_KEY,
      legacyBearerToken: null,
      secureCookies: false,
    },
  });
});

afterEach(() => {
  brain.close();
  users.close();
});

describe('cross-namespace authz — entity ID routes', () => {
  it('rejects GET /api/entities/:id when the entity belongs to a different namespace', async () => {
    // Seed an entity in namespace 'beta' directly via Brain (bypasses auth).
    const e = brain.entities.create({
      type: 'file',
      name: 'beta-secret.ts',
      namespace: 'beta',
      source: { type: 'manual' },
    });

    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get(`/api/entities/${e.id}`)
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('namespace-mismatch');
  });

  it('rejects PATCH /api/entities/:id across namespaces', async () => {
    const e = brain.entities.create({
      type: 'file',
      name: 'beta.ts',
      namespace: 'beta',
      source: { type: 'manual' },
    });
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .patch(`/api/entities/${e.id}`)
      .set('Authorization', `Bearer ${pat}`)
      .send({ name: 'renamed' });
    expect(res.status).toBe(403);
  });

  it('rejects DELETE /api/entities/:id across namespaces', async () => {
    const e = brain.entities.create({
      type: 'file',
      name: 'beta.ts',
      namespace: 'beta',
      source: { type: 'manual' },
    });
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .delete(`/api/entities/${e.id}`)
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
    // Entity still present.
    expect(brain.entities.get(e.id)).not.toBeNull();
  });

  it('rejects observation add/remove across namespaces', async () => {
    const e = brain.entities.create({
      type: 'file',
      name: 'beta.ts',
      namespace: 'beta',
      source: { type: 'manual' },
    });
    const { pat } = await mintTokenLockedTo('alpha');
    const addRes = await request(app)
      .post(`/api/entities/${e.id}/observations`)
      .set('Authorization', `Bearer ${pat}`)
      .send({ observation: 'leaked' });
    expect(addRes.status).toBe(403);
    const delRes = await request(app)
      .delete(`/api/entities/${e.id}/observations`)
      .set('Authorization', `Bearer ${pat}`)
      .send({ observation: 'whatever' });
    expect(delRes.status).toBe(403);
  });

  it('rejects POST /api/entities into a different namespace via body', async () => {
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .post('/api/entities')
      .set('Authorization', `Bearer ${pat}`)
      .send({ type: 'file', name: 'x.ts', namespace: 'beta' });
    // The middleware itself catches this via pickRequestedNamespace.
    expect(res.status).toBe(403);
  });

  it('allows access within the matching namespace', async () => {
    const e = brain.entities.create({
      type: 'file',
      name: 'alpha.ts',
      namespace: 'alpha',
      source: { type: 'manual' },
    });
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get(`/api/entities/${e.id}`)
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(200);
  });
});

describe('cross-namespace authz — sync path-param routes', () => {
  it('rejects GET /api/sync/status/:namespace across namespaces', async () => {
    // Sync routes are gated by the sync manager being wired; createApp wires
    // it. Whether the namespace is "synced" or not, we still expect a 403
    // before the route's own 404 fires.
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get('/api/sync/status/beta')
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('namespace-mismatch');
  });

  it('rejects GET /api/sync/peers/:namespace across namespaces', async () => {
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get('/api/sync/peers/beta')
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
  });
});

describe('scope enforcement', () => {
  it("rejects writes from a hook:read-only token (insufficient-scope)", async () => {
    const u = users.createUser({ id: generateUserId(), email: 'hook@t', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['hook:read'],
      namespace: 'alpha',
    });
    const res = await request(app)
      .post('/api/entities')
      .set('Authorization', `Bearer ${minted.pat}`)
      .send({ type: 'file', name: 'x.ts', namespace: 'alpha' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient-scope');
  });
});

describe('unbound token without namespace — must be rejected', () => {
  it('rejects /api/search from an unbound PAT when no ?namespace= is given (no all-namespace scan)', async () => {
    // Mint an unbound PAT (`tokens.namespace IS NULL`) with two memberships.
    const u = users.createUser({ id: generateUserId(), email: 'unbound@t.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'beta', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read', 'write'],
      namespace: null, // unbound
    });
    const res = await request(app)
      .get('/api/search?q=anything')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('namespace-required');
  });

  it('an unbound PAT WITH an explicit ?namespace=alpha succeeds when membership exists', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'unbound2@t.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'], namespace: null });
    const res = await request(app)
      .get('/api/search?q=anything&namespace=alpha')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(200);
  });
});

describe('cross-namespace authz — read routes (search / stats / temporal / parallel-work)', () => {
  it("forces token namespace on /api/search even when the request omits ?namespace=", async () => {
    // Seed entities in both namespaces.
    brain.entities.create({ type: 'file', name: 'alpha-file.ts', namespace: 'alpha', source: { type: 'manual' } });
    brain.entities.create({ type: 'file', name: 'beta-secret.ts', namespace: 'beta', source: { type: 'manual' } });

    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get('/api/search?q=file')
      .set('Authorization', `Bearer ${pat}`)
      .expect(200);
    // Only alpha results — beta-secret is invisible.
    const names: string[] = res.body.map((r: { entity: { name: string } }) => r.entity.name);
    expect(names).toContain('alpha-file.ts');
    expect(names).not.toContain('beta-secret.ts');
  });

  it('rejects /api/search?namespace=beta when token is locked to alpha', async () => {
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get('/api/search?q=anything&namespace=beta')
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('namespace-mismatch');
  });

  it('forces token namespace on /api/stats', async () => {
    brain.entities.create({ type: 'file', name: 'a.ts', namespace: 'alpha', source: { type: 'manual' } });
    brain.entities.create({ type: 'file', name: 'b.ts', namespace: 'beta', source: { type: 'manual' } });
    brain.entities.create({ type: 'file', name: 'b2.ts', namespace: 'beta', source: { type: 'manual' } });
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', `Bearer ${pat}`)
      .expect(200);
    // Only the alpha entity is counted.
    expect(res.body.totalEntities).toBe(1);
  });

  it('rejects /api/timeline across namespaces', async () => {
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .get(`/api/timeline?from=2024-01-01T00:00:00Z&to=2030-01-01T00:00:00Z&namespace=beta`)
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
  });
});

describe('cross-namespace authz — contradiction mutations', () => {
  it('rejects POST /api/contradictions/:id/resolve across namespaces', async () => {
    const a = brain.entities.create({
      type: 'file', name: 'a.ts', namespace: 'beta', source: { type: 'manual' },
    });
    const b = brain.entities.create({
      type: 'file', name: 'b.ts', namespace: 'beta', source: { type: 'manual' },
    });
    const r = brain.relations.create({
      type: 'contradicts', sourceId: a.id, targetId: b.id,
      namespace: 'beta', source: { type: 'manual' },
    });
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .post(`/api/contradictions/${r.id}/resolve`)
      .set('Authorization', `Bearer ${pat}`)
      .send({ winnerId: a.id });
    expect(res.status).toBe(403);
  });

  it('rejects DELETE /api/contradictions/:id across namespaces', async () => {
    const a = brain.entities.create({
      type: 'file', name: 'a2.ts', namespace: 'beta', source: { type: 'manual' },
    });
    const b = brain.entities.create({
      type: 'file', name: 'b2.ts', namespace: 'beta', source: { type: 'manual' },
    });
    const r = brain.relations.create({
      type: 'contradicts', sourceId: a.id, targetId: b.id,
      namespace: 'beta', source: { type: 'manual' },
    });
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .delete(`/api/contradictions/${r.id}`)
      .set('Authorization', `Bearer ${pat}`);
    expect(res.status).toBe(403);
  });
});

describe('admin guard on pipeline routes', () => {
  it('rejects POST /api/reindex from a non-admin token', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'm@t.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read', 'write'],
      namespace: 'alpha',
    });
    const res = await request(app)
      .post('/api/reindex')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin-required');
  });

  it('accepts POST /api/reindex from an admin token', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'a@t.test', role: 'admin' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'admin' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['admin'],
      namespace: 'alpha',
    });
    const res = await request(app)
      .post('/api/reindex')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/tokens (admin-only)', () => {
  it('rejects a non-admin caller with 403', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'm@t.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'alpha', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read', 'write'],
      namespace: 'alpha',
    });
    const res = await request(app)
      .get('/api/admin/tokens?email=m@t.test')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 when email is missing', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'a@t.test', role: 'admin' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['admin'],
      namespace: null,
    });
    const res = await request(app)
      .get('/api/admin/tokens')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email-required');
  });

  it('returns 404 when the user does not exist', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'a@t.test', role: 'admin' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['admin'],
      namespace: null,
    });
    const res = await request(app)
      .get('/api/admin/tokens?email=ghost@t.test')
      .set('Authorization', `Bearer ${minted.pat}`);
    expect(res.status).toBe(404);
  });

  it('returns the target user tokens without exposing the secret hash', async () => {
    const admin = users.createUser({ id: generateUserId(), email: 'a@t.test', role: 'admin' });
    const adminMint = await users.mintPat({
      userId: admin.id,
      scopes: ['admin'],
      namespace: null,
    });

    const target = users.createUser({ id: generateUserId(), email: 'm@t.test', role: 'member' });
    users.addNamespaceMembership({ userId: target.id, namespace: 'alpha', role: 'member' });
    await users.mintPat({
      userId: target.id,
      label: 'laptop',
      scopes: ['read', 'write'],
      namespace: 'alpha',
    });
    await users.mintPat({
      userId: target.id,
      label: 'ci',
      scopes: ['read'],
      namespace: 'alpha',
    });

    const res = await request(app)
      .get('/api/admin/tokens?email=m@t.test')
      .set('Authorization', `Bearer ${adminMint.pat}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens).toHaveLength(2);
    for (const t of res.body.tokens) {
      expect(t.id).toMatch(/^[a-z0-9]{8}$/);
      expect(t.userId).toBe(target.id);
      expect(typeof t.createdAt).toBe('number');
      // Critical: hash must never be returned.
      expect('hash' in t).toBe(false);
    }
    expect(res.body.tokens.map((t: { label: string }) => t.label).sort()).toEqual(['ci', 'laptop']);
  });
});

describe('observe session-start project field is namespace-checked', () => {
  it('rejects a session-start whose `project` differs from the token namespace', async () => {
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .post('/api/observe/session-start')
      .set('Authorization', `Bearer ${pat}`)
      .send({ sessionId: 'sx', tool: 'claude', project: 'beta' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('namespace-mismatch');
  });

  it('rejects when body.namespace matches but body.project leaks a different namespace', async () => {
    // Token bound to alpha. Body has namespace=alpha (passes) AND project=beta
    // (must be rejected). The middleware must validate ALL namespace surfaces,
    // not just the first one it finds.
    const { pat } = await mintTokenLockedTo('alpha');
    const res = await request(app)
      .post('/api/entities')
      .set('Authorization', `Bearer ${pat}`)
      .send({
        type: 'file',
        name: 'mixed.ts',
        namespace: 'alpha',
        // Real entities don't carry `project`, but the middleware sees it and
        // must reject. This test guards against silent regression of the
        // multi-surface-bypass class of bugs.
        project: 'beta',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('namespace-mismatch');
  });
});
