import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  UsersService,
  parsePat,
  generateUserId,
  getArgon2Options,
  hashMatchesPolicy,
} from '../services/users.js';
import * as argon2 from 'argon2';

let users: UsersService;

beforeEach(() => {
  users = new UsersService({ path: ':memory:' });
});

afterEach(() => {
  users.close();
});

describe('users service — schema', () => {
  it('initializes schema idempotently', () => {
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

  it('parsePat handles malformed tokens', async () => {
    // Garbage / wrong prefix.
    expect(parsePat('not-a-pat')).toBeNull();
    expect(parsePat('sbp_short')).toBeNull();
    // Old base32-only shape (no CRC32 suffix) — must be rejected.
    expect(parsePat('sbp_abcdefgh_AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP')).toBeNull();
    // Freshly minted token round-trips through parse.
    const u = users.createUser({ id: generateUserId(), email: 'parse@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    const parsed = parsePat(minted.pat);
    expect(parsed).not.toBeNull();
    expect(parsed!.tokenId).toBe(minted.tokenId);
  });

  it('mintPat output matches the new PAT regex (sbp_<8>_<32>_<6>)', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'fmt@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    expect(minted.pat).toMatch(/^sbp_[a-z0-9]{8}_[A-Za-z0-9]{32}_[A-Za-z0-9]{6}$/);
  });

  it('verifyPat rejects a PAT when the secret is tampered (CRC32 mismatch)', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'crc@b.test', role: 'member' });
    const minted = await users.mintPat({ userId: u.id, scopes: ['read'] });
    // Mutate one character in the secret group (positions 13..44 of `sbp_xxxxxxxx_<secret>_<crc>`)
    // — leaves the regex matchable but breaks the CRC32 check.
    const idxInSecret = 15;
    const ch = minted.pat[idxInSecret];
    const replacement = ch === 'A' ? 'B' : 'A';
    const tampered = minted.pat.slice(0, idxInSecret) + replacement + minted.pat.slice(idxInSecret + 1);
    expect(tampered).not.toBe(minted.pat);
    expect(tampered).toMatch(/^sbp_[a-z0-9]{8}_[A-Za-z0-9]{32}_[A-Za-z0-9]{6}$/);
    expect(parsePat(tampered)).toBeNull();
    expect(await users.verifyPat(tampered)).toBeNull();
  });

  it('verifyPat rejects an old-format-shaped PAT (no CRC32 suffix)', async () => {
    // 8-id + 32-char base62 secret, no _<6> suffix → fails new regex outright.
    const oldFormat = 'sbp_abcdefgh_aaaaaaaaBBBBBBBBccccccccDDDDDDDD';
    expect(oldFormat).not.toMatch(/^sbp_[a-z0-9]{8}_[A-Za-z0-9]{32}_[A-Za-z0-9]{6}$/);
    expect(parsePat(oldFormat)).toBeNull();
    expect(await users.verifyPat(oldFormat)).toBeNull();
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

describe('users service — argon2 env-config policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to m=65536 / t=3 / p=1 when env vars are unset', () => {
    vi.stubEnv('BRAIN_ARGON2_M', '');
    vi.stubEnv('BRAIN_ARGON2_T', '');
    vi.stubEnv('BRAIN_ARGON2_P', '');
    const opts = getArgon2Options();
    expect(opts.memoryCost).toBe(65_536);
    expect(opts.timeCost).toBe(3);
    expect(opts.parallelism).toBe(1);
    expect(opts.type).toBe(argon2.argon2id);
  });

  it('refuses to start when params fall below BOTH OWASP baselines', () => {
    vi.stubEnv('BRAIN_ARGON2_M', '1024');
    vi.stubEnv('BRAIN_ARGON2_T', '1');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    expect(() => getArgon2Options()).toThrow(/below both OWASP baselines/);
    // Error names the offending vars.
    expect(() => getArgon2Options()).toThrow(/BRAIN_ARGON2_M=1024/);
  });

  it('accepts the small-VPS baseline (m=19456, t=2, p=1)', () => {
    vi.stubEnv('BRAIN_ARGON2_M', '19456');
    vi.stubEnv('BRAIN_ARGON2_T', '2');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    const opts = getArgon2Options();
    expect(opts.memoryCost).toBe(19_456);
    expect(opts.timeCost).toBe(2);
    expect(opts.parallelism).toBe(1);
  });

  it('accepts the high-mem baseline (m=47104, t=1, p=1)', () => {
    vi.stubEnv('BRAIN_ARGON2_M', '47104');
    vi.stubEnv('BRAIN_ARGON2_T', '1');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    expect(() => getArgon2Options()).not.toThrow();
  });

  it('rejects malformed env values (non-positive integer) with named error', () => {
    vi.stubEnv('BRAIN_ARGON2_M', 'not-a-number');
    expect(() => getArgon2Options()).toThrow(/Invalid BRAIN_ARGON2_M/);
  });

  it('mintPat produces a hash whose encoded prefix matches the configured params', async () => {
    vi.stubEnv('BRAIN_ARGON2_M', '19456');
    vi.stubEnv('BRAIN_ARGON2_T', '2');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    const localUsers = new UsersService({ path: ':memory:' });
    const u = localUsers.createUser({
      id: generateUserId(),
      email: 'tune@b.test',
      role: 'member',
    });
    const minted = await localUsers.mintPat({ userId: u.id, scopes: ['read'] });
    const row = localUsers.db
      .prepare('SELECT hash FROM tokens WHERE id = ?')
      .get(minted.tokenId) as { hash: string };
    // Encoded shape: $argon2id$v=19$m=<m>,t=<t>,p=<p>$salt$hash
    const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(row.hash);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(19_456);
    expect(Number(m![2])).toBe(2);
    expect(Number(m![3])).toBe(1);
    expect(hashMatchesPolicy(row.hash)).toBe(true);
    // Verify still works.
    expect(await localUsers.verifyPat(minted.pat)).not.toBeNull();
    localUsers.close();
  });
});
