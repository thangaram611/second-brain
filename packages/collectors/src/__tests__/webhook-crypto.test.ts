import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  pickHeader,
  verifyToken,
  verifyHmac,
  HttpError,
  httpError,
  statusOf,
} from '../providers/webhook-crypto.js';

describe('pickHeader', () => {
  it('is case-insensitive', () => {
    expect(pickHeader({ 'X-Gitlab-Token': 'abc' }, 'x-gitlab-token')).toBe('abc');
  });

  it('returns the first element for array values', () => {
    expect(pickHeader({ 'x-h': ['first', 'second'] }, 'x-h')).toBe('first');
  });

  it('returns undefined when absent', () => {
    expect(pickHeader({ other: 'v' }, 'x-missing')).toBeUndefined();
  });
});

describe('verifyToken', () => {
  it('returns ok on exact match', () => {
    expect(verifyToken('secret-value', 'secret-value')).toEqual({ ok: true });
  });

  it('returns mismatch on differing length', () => {
    expect(verifyToken('short', 'a-much-longer-value')).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('returns mismatch on same-length different value', () => {
    expect(verifyToken('aaaa', 'bbbb')).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('verifyHmac', () => {
  const secret = 'topsecret';
  const rawBody = Buffer.from('{"hello":"world"}');
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');

  it('matches a known fixture with prefix', () => {
    expect(
      verifyHmac({ received: `sha256=${digest}`, rawBody, secret, algorithm: 'sha256', prefix: 'sha256=' }),
    ).toEqual({ ok: true });
  });

  it('matches a bare digest without prefix', () => {
    expect(verifyHmac({ received: digest, rawBody, secret, algorithm: 'sha256' })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    expect(
      verifyHmac({
        received: `sha256=${digest}`,
        rawBody: Buffer.from('{"hello":"tampered"}'),
        secret,
        algorithm: 'sha256',
        prefix: 'sha256=',
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a wrong secret', () => {
    expect(
      verifyHmac({ received: `sha256=${digest}`, rawBody, secret: 'wrong', algorithm: 'sha256', prefix: 'sha256=' }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('httpError / statusOf', () => {
  it('builds an HttpError carrying the status', () => {
    const res = new Response(null, { status: 404, statusText: 'Not Found' });
    const err = httpError(res, 'repos/x', 'GitHub');
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.message).toContain('GitHub API 404');
  });

  it('statusOf returns the number for status-shaped errors', () => {
    expect(statusOf(new HttpError('boom', 404))).toBe(404);
    expect(statusOf({ status: 500 })).toBe(500);
  });

  it('statusOf returns undefined otherwise', () => {
    expect(statusOf(new Error('plain'))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf({ code: 'X' })).toBeUndefined();
  });
});
