import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  adminInvite,
  adminTokenList,
  adminTokenRevoke,
  parseTtlMs,
} from '../admin.js';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.BRAIN_AUTH_TOKEN = 'admin-bearer';
  process.env.BRAIN_API_URL = 'http://server.test';
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('parseTtlMs', () => {
  it('handles plain ms', () => {
    expect(parseTtlMs('1500')).toBe(1500);
    expect(parseTtlMs('1500ms')).toBe(1500);
  });

  it('handles seconds, minutes, hours, days', () => {
    expect(parseTtlMs('30s')).toBe(30_000);
    expect(parseTtlMs('5m')).toBe(300_000);
    expect(parseTtlMs('24h')).toBe(86_400_000);
    expect(parseTtlMs('7d')).toBe(7 * 86_400_000);
  });

  it('rejects malformed input', () => {
    expect(() => parseTtlMs('soon')).toThrow();
    expect(() => parseTtlMs('-1h')).toThrow();
    expect(() => parseTtlMs('0d')).toThrow();
    expect(() => parseTtlMs('5y')).toThrow();
    expect(() => parseTtlMs('1.5h')).toThrow();
  });

  it('rejects unsafe-integer overflow', () => {
    // ~285k years in days is well beyond MAX_SAFE_INTEGER ms.
    expect(() => parseTtlMs('999999999999999999d')).toThrow(/safe integer|invalid TTL/);
    // Also reject inputs that are themselves above MAX_SAFE_INTEGER.
    expect(() => parseTtlMs(`${Number.MAX_SAFE_INTEGER + 1}ms`)).toThrow();
  });

  it('accepts MAX_SAFE_INTEGER ms exactly', () => {
    expect(parseTtlMs(`${Number.MAX_SAFE_INTEGER}ms`)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

function makeFakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(u, init ?? {});
  }) as unknown as typeof fetch;
}

describe('adminInvite', () => {
  it('POSTs to /api/admin/invites with bearer auth and TTL in ms', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = makeFakeFetch(async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          invite: 'tok.sig',
          jti: 'abc123',
          expiresAt: Date.now() + 60_000,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await adminInvite({
      namespace: 'team-x',
      ttl: '12h',
      role: 'admin',
      scopes: 'read,write,admin',
      fetchImpl,
    });
    expect(result.invite).toBe('tok.sig');
    expect(captured!.url).toBe('http://server.test/api/admin/invites');
    expect(captured!.init.method).toBe('POST');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer admin-bearer');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.namespace).toBe('team-x');
    expect(body.role).toBe('admin');
    expect(body.scopes).toEqual(['read', 'write', 'admin']);
    expect(body.ttlMs).toBe(12 * 3_600_000);
  });

  it('throws on HTTP failure with status text in the message', async () => {
    const fetchImpl = makeFakeFetch(async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    );
    await expect(
      adminInvite({ namespace: 'x', fetchImpl }),
    ).rejects.toThrow(/403/);
  });

  it('rejects unknown scopes locally', async () => {
    await expect(
      adminInvite({ namespace: 'x', scopes: 'read,nope' }),
    ).rejects.toThrow(/unknown scope/);
  });
});

describe('adminTokenList', () => {
  it('GETs /api/admin/tokens with the email query, returns the parsed list', async () => {
    let capturedUrl = '';
    const fetchImpl = makeFakeFetch(async (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          tokens: [
            {
              id: 'tttttttt',
              userId: 'usr_1',
              label: 'laptop',
              scopes: ['read', 'write'],
              namespace: 'alpha',
              createdAt: 1,
              lastUsedAt: null,
              expiresAt: null,
              revokedAt: null,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const list = await adminTokenList({ email: 'a@b.test', fetchImpl });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('tttttttt');
    expect(capturedUrl).toBe('http://server.test/api/admin/tokens?email=a%40b.test');
  });

  it('rejects when the response shape is wrong', async () => {
    const fetchImpl = makeFakeFetch(async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }),
    );
    await expect(adminTokenList({ email: 'a@b.test', fetchImpl })).rejects.toThrow();
  });
});

describe('adminTokenRevoke', () => {
  it('DELETEs the token and returns true on 204', async () => {
    let captured: { url: string; method: string } | null = null;
    const fetchImpl = makeFakeFetch(async (url, init) => {
      captured = { url, method: init.method ?? 'GET' };
      return new Response(null, { status: 204 });
    });
    const ok = await adminTokenRevoke({ tokenId: 'aaaaaaaa', fetchImpl });
    expect(ok).toBe(true);
    expect(captured!.url).toBe('http://server.test/api/admin/tokens/aaaaaaaa');
    expect(captured!.method).toBe('DELETE');
  });

  it('throws on 404', async () => {
    const fetchImpl = makeFakeFetch(async () =>
      new Response('not-found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(adminTokenRevoke({ tokenId: 'absent', fetchImpl })).rejects.toThrow(/404/);
  });
});
