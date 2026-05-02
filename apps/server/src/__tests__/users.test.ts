import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UsersService, parsePat, generateUserId } from '../services/users.js';

let users: UsersService;

beforeEach(() => {
  users = new UsersService({ path: ':memory:' });
});

afterEach(() => {
  users.close();
});

describe('users service — schema', () => {
  it('runs migrations idempotently', () => {
    // Re-applying schema must not throw.
    const second = new UsersService({ path: ':memory:' });
    expect(second).toBeDefined();
    second.close();
  });

  it('creates and finds users by email and id', () => {
    const u = users.createUser({ id: generateUserId(), email: 'a@b.test', role: 'member' });
    expect(users.findUserByEmail('a@b.test')?.id).toBe(u.id);
    expect(users.findUserById(u.id)?.email).toBe('a@b.test');
  });

  it('upsertUser is idempotent', () => {
    const a = users.upsertUser({ email: 'x@y.test', role: 'admin' });
    const b = users.upsertUser({ email: 'x@y.test', role: 'member' });
    expect(a.id).toBe(b.id);
    expect(b.role).toBe('admin'); // role from existing row preserved
  });
});

describe('users service — namespace memberships', () => {
  it('records user_namespaces entries and looks them up', () => {
    const u = users.createUser({ id: generateUserId(), email: 'm@b.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'platform', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'auth', role: 'admin' });
    const list = users.listNamespaces(u.id);
    expect(list.map((l) => l.namespace).sort()).toEqual(['auth', 'platform']);
    expect(users.hasNamespaceMembership(u.id, 'auth')).toBe(true);
    expect(users.hasNamespaceMembership(u.id, 'finance')).toBe(false);
  });

  it('upserts membership when re-added with a new role', () => {
    const u = users.createUser({ id: generateUserId(), email: 'm2@b.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'platform', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'platform', role: 'admin' });
    const list = users.listNamespaces(u.id);
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe('admin');
  });
});

describe('users service — token namespace binding', () => {
  it('mintPat with namespace=null leaves the token unlocked', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'tok@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    const verified = await users.verifyPat(minted.pat);
    expect(verified).not.toBeNull();
    expect(verified!.record.namespace).toBeNull();
  });

  it('mintPat with namespace locks the token to that namespace', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'tok2@b.test', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['hook:read'],
      namespace: 'acme-platform',
    });
    const verified = await users.verifyPat(minted.pat);
    expect(verified!.record.namespace).toBe('acme-platform');
  });

  it('parsePat handles malformed tokens', () => {
    expect(parsePat('not-a-pat')).toBeNull();
    expect(parsePat('sbp_short')).toBeNull();
    expect(parsePat('sbp_abcdefgh_AABBCC')).not.toBeNull();
  });
});

describe('users service — token revocation', () => {
  it('revokeToken disables verification', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'rev@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    expect(await users.verifyPat(minted.pat)).not.toBeNull();
    expect(users.revokeToken(minted.tokenId)).toBe(true);
    expect(await users.verifyPat(minted.pat)).toBeNull();
  });

  it('revokeToken returns false on second call', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'rev2@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    expect(users.revokeToken(minted.tokenId)).toBe(true);
    expect(users.revokeToken(minted.tokenId)).toBe(false);
  });

  it('expired tokens fail verification', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'exp@b.test', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read'],
      expiresAt: Date.now() - 1000,
    });
    expect(await users.verifyPat(minted.pat)).toBeNull();
  });

  it('disabled users fail verification', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'dis@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    users.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), u.id);
    expect(await users.verifyPat(minted.pat)).toBeNull();
  });
});

describe('users service — invites and sessions', () => {
  it('consumeInvite is single-use', () => {
    users.insertInvite({
      jti: 'jti-1',
      namespace: 'team',
      role: 'member',
      scopes: ['read'],
      expiresAt: Date.now() + 60_000,
      consumedAt: null,
      signature: 'sig',
      createdAt: Date.now(),
    });
    expect(users.consumeInvite('jti-1')).toBe(true);
    expect(users.consumeInvite('jti-1')).toBe(false);
  });

  it('sessions have CSRF token and TTL', () => {
    const u = users.createUser({ id: generateUserId(), email: 's@b.test', role: 'member' });
    const session = users.createSession({
      userId: u.id,
      namespace: 'team',
      expiresAt: Date.now() + 60_000,
    });
    expect(session.csrfToken).toMatch(/^[a-f0-9]{48}$/);
    expect(users.getSession(session.id)?.userId).toBe(u.id);
    users.deleteSession(session.id);
    expect(users.getSession(session.id)).toBeNull();
  });
});
