import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Brain } from '@second-brain/core';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { UsersService, generateUserId } from '../services/users.js';
import { newJti, signInvite } from '../lib/invite.js';

const INVITE_KEY = 'invite-key-test-123456';
const SERVER_KEY = 'server-key-test-123456';

let brain: Brain;
let users: UsersService;
let app: Express;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  users = new UsersService({ path: ':memory:' });
  app = createApp(brain, {
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

function makeInvite(opts?: { ttlMs?: number; namespace?: string; role?: 'member' | 'admin' }): string {
  const ttl = opts?.ttlMs ?? 60 * 60 * 1000;
  const ns = opts?.namespace ?? 'team';
  const role = opts?.role ?? 'member';
  return signInvite(
    {
      jti: newJti(),
      namespace: ns,
      role,
      scopes: ['read', 'write'],
      exp: Math.floor((Date.now() + ttl) / 1000),
    },
    INVITE_KEY,
  );
}

describe('POST /api/auth/redeem-invite', () => {
  it('mints a PAT and registers user + namespace membership', async () => {
    const invite = makeInvite();
    const res = await request(app)
      .post('/api/auth/redeem-invite')
      .send({ invite })
      .expect(201);

    expect(res.body.pat).toMatch(/^sbp_[a-z0-9]{8}_[A-Z2-7]+$/);
    expect(res.body.tokenId).toMatch(/^[a-z0-9]{8}$/);
    expect(res.body.userId).toMatch(/^usr_/);
    expect(res.body.expiresAt).toBeDefined();

    const user = users.findUserById(res.body.userId);
    expect(user).not.toBeNull();
    expect(users.hasNamespaceMembership(user!.id, 'team')).toBe(true);
  });

  it('rejects invalid signatures', async () => {
    const invite = signInvite(
      {
        jti: newJti(),
        namespace: 'team',
        role: 'member',
        scopes: ['read'],
        exp: Math.floor((Date.now() + 60_000) / 1000),
      },
      'wrong-key',
    );
    const res = await request(app)
      .post('/api/auth/redeem-invite')
      .send({ invite })
      .expect(400);
    expect(res.body.error).toBe('invalid-invite');
    expect(res.body.reason).toBe('bad-signature');
  });

  it('rejects expired invites', async () => {
    const invite = signInvite(
      {
        jti: newJti(),
        namespace: 'team',
        role: 'member',
        scopes: [],
        exp: Math.floor((Date.now() - 60_000) / 1000),
      },
      INVITE_KEY,
    );
    const res = await request(app)
      .post('/api/auth/redeem-invite')
      .send({ invite })
      .expect(400);
    expect(res.body.reason).toBe('expired');
  });

  it('enforces single-use redemption', async () => {
    const invite = makeInvite();
    await request(app).post('/api/auth/redeem-invite').send({ invite }).expect(201);
    const res = await request(app)
      .post('/api/auth/redeem-invite')
      .send({ invite })
      .expect(409);
    expect(res.body.error).toBe('invite-already-consumed');
  });

  it('serializes concurrent redeem requests with at most one success', async () => {
    const invite = makeInvite();
    const results = await Promise.all([
      request(app).post('/api/auth/redeem-invite').send({ invite }),
      request(app).post('/api/auth/redeem-invite').send({ invite }),
      request(app).post('/api/auth/redeem-invite').send({ invite }),
    ]);
    const successes = results.filter((r) => r.status === 201);
    expect(successes).toHaveLength(1);
  });
});

describe('PAT verification on /api/*', () => {
  it('rejects requests without a token in pat mode', async () => {
    await request(app).get('/api/auth/whoami').expect(401);
  });

  it('accepts a freshly minted PAT', async () => {
    const invite = makeInvite();
    const minted = await request(app).post('/api/auth/redeem-invite').send({ invite });
    const pat = minted.body.pat as string;

    const res = await request(app)
      .get('/api/auth/whoami')
      .set('Authorization', `Bearer ${pat}`)
      .expect(200);
    expect(res.body.userId).toBe(minted.body.userId);
    expect(res.body.namespace).toBe('team');
    expect(res.body.role).toBe('member');
  });

  it('rejects revoked PATs', async () => {
    const invite = makeInvite();
    const minted = await request(app).post('/api/auth/redeem-invite').send({ invite });
    users.revokeToken(minted.body.tokenId);
    await request(app)
      .get('/api/auth/whoami')
      .set('Authorization', `Bearer ${minted.body.pat}`)
      .expect(401);
  });
});

describe('login + session + CSRF', () => {
  async function bootstrapUserAndPat(): Promise<{ pat: string; userId: string; email: string }> {
    const u = users.createUser({ id: generateUserId(), email: 'jane@acme.dev', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'team', role: 'member' });
    const minted = await users.mintPat({
      userId: u.id,
      scopes: ['read', 'write'],
      namespace: 'team',
    });
    return { pat: minted.pat, userId: u.id, email: u.email };
  }

  it('login sets a session cookie + returns CSRF token', async () => {
    const { pat, email, userId } = await bootstrapUserAndPat();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, pat })
      .expect(200);
    expect(res.body.csrfToken).toBeTruthy();
    expect(res.body.userId).toBe(userId);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(cookieStr).toContain('sb_session=');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Lax');
  });

  it('login rejects bad credentials', async () => {
    await request(app).post('/api/auth/login').send({ email: 'no@one.test', pat: 'sbp_xxxxxxxx_AAAA' }).expect(401);
  });

  it('whoami via session cookie works without bearer', async () => {
    const { pat, email } = await bootstrapUserAndPat();
    const login = await request(app).post('/api/auth/login').send({ email, pat });
    const cookies = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
    const res = await request(app)
      .get('/api/auth/whoami')
      .set('Cookie', cookieHeader)
      .expect(200);
    expect(res.body.email).toBe(email);
    expect(res.body.csrfToken).toBe(login.body.csrfToken);
  });

  it('session-authed write requires CSRF header', async () => {
    const { pat, email } = await bootstrapUserAndPat();
    const login = await request(app).post('/api/auth/login').send({ email, pat });
    const cookies = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
    // No CSRF — writes blocked
    await request(app)
      .post('/api/auth/rotate')
      .set('Cookie', cookieHeader)
      .send({})
      .expect(403);
    // With CSRF — accepted (rotation will succeed because tokenId is in user)
    const minted = users.listTokens(login.body.userId)[0];
    const res = await request(app)
      .post('/api/auth/rotate')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', login.body.csrfToken)
      .send({ tokenId: minted.id })
      .expect(201);
    expect(res.body.pat).toBeTruthy();
  });

  it('logout invalidates the session', async () => {
    const { pat, email } = await bootstrapUserAndPat();
    const login = await request(app).post('/api/auth/login').send({ email, pat });
    const cookies = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', login.body.csrfToken)
      .expect(204);
    await request(app)
      .get('/api/auth/whoami')
      .set('Cookie', cookieHeader)
      .expect(401);
  });
});

describe('rotate', () => {
  it('mints a new PAT and revokes the old one', async () => {
    const u = users.createUser({ id: generateUserId(), email: 'rot@b.test', role: 'member' });
    users.addNamespaceMembership({ userId: u.id, namespace: 'ns', role: 'member' });
    const old = await users.mintPat({ userId: u.id, scopes: ['read'], namespace: 'ns' });
    const res = await request(app)
      .post('/api/auth/rotate')
      .set('Authorization', `Bearer ${old.pat}`)
      .send({})
      .expect(201);
    expect(res.body.pat).not.toBe(old.pat);
    expect(await users.verifyPat(old.pat)).toBeNull();
    expect(await users.verifyPat(res.body.pat)).not.toBeNull();
  });
});

describe('open mode back-compat', () => {
  it('permits unauth requests when BRAIN_AUTH_MODE is open', async () => {
    const brain2 = new Brain({ path: ':memory:', wal: false });
    const users2 = new UsersService({ path: ':memory:' });
    const app2 = createApp(brain2, {
      auth: {
        mode: 'open',
        users: users2,
        inviteSigningKey: INVITE_KEY,
        legacyBearerToken: null,
      },
    });
    // /api/auth/whoami still 401s because there's no user; but a no-auth-required
    // health/route is /health which doesn't use /api/. Use /api/embeddings/status.
    await request(app2).get('/api/embeddings/status').expect(200);
    brain2.close();
    users2.close();
  });
});
