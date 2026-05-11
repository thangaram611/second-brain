import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { Brain } from '@second-brain/core';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { UsersService, generateUserId } from '../services/users.js';

const INVITE_KEY = 'invite-key-test-123456';

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

const InviteResponseSchema = z.object({
  invite: z.string().min(1),
  jti: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

async function bootstrapAdmin(opts: {
  namespace: string | null;
}): Promise<{ pat: string; userId: string }> {
  const u = users.createUser({
    id: generateUserId(),
    email: 'admin@example.com',
    role: 'admin',
  });
  if (opts.namespace !== null) {
    users.addNamespaceMembership({
      userId: u.id,
      namespace: opts.namespace,
      role: 'admin',
    });
  }
  // Bootstrap mirror: NULL-namespace admin PAT.
  const minted = await users.mintPat({
    userId: u.id,
    scopes: ['admin'],
    namespace: null,
  });
  return { pat: minted.pat, userId: u.id };
}

describe('POST /api/admin/invites (T1 — namespace-membership-gated)', () => {
  it('mints an invite when the admin has a user_namespaces row for the target namespace', async () => {
    const { pat } = await bootstrapAdmin({ namespace: 'alpha' });

    const res = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', `Bearer ${pat}`)
      .send({ namespace: 'alpha', role: 'member', ttlMs: 86_400_000 })
      .expect(201);

    const body = InviteResponseSchema.parse(res.body);
    expect(body.invite.length).toBeGreaterThan(0);
    expect(body.jti.length).toBeGreaterThan(0);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns 403 namespace-mismatch when the admin has no membership for the target namespace', async () => {
    // No membership row → reproduces the broken bootstrap state that T1 fixes.
    const { pat } = await bootstrapAdmin({ namespace: null });

    const res = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', `Bearer ${pat}`)
      .send({ namespace: 'alpha', role: 'member', ttlMs: 86_400_000 })
      .expect(403);

    expect(res.body.error).toBe('namespace-mismatch');
  });
});
