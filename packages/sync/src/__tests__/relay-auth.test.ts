import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { RelayAuthPayloadSchema } from '@second-brain/types';
import { signRelayToken } from '../relay-auth.js';

const SECRET = 'sync-test-relay-secret';

describe('signRelayToken', () => {
  it('mints a token the relay schema accepts, with read+write permissions', () => {
    const token = signRelayToken(SECRET, { sub: 'alice@example.com', namespace: 'project-x' });
    const payload = RelayAuthPayloadSchema.parse(jwt.verify(token, SECRET));

    expect(payload.sub).toBe('alice@example.com');
    expect(payload.namespace).toBe('project-x');
    expect(payload.permissions).toEqual(['read', 'write']);
    expect(payload.exp - payload.iat).toBe(86_400); // default 24h
  });

  it('honors a custom expiry', () => {
    const token = signRelayToken(SECRET, { sub: 'bob', namespace: 'ns', expiresInSeconds: 60 });
    const payload = RelayAuthPayloadSchema.parse(jwt.verify(token, SECRET));
    expect(payload.exp - payload.iat).toBe(60);
  });

  it('signs with the secret — a wrong secret fails verification', () => {
    const token = signRelayToken(SECRET, { sub: 'a', namespace: 'ns' });
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });
});
