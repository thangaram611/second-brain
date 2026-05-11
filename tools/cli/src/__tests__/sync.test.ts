/**
 * T2 — `brain sync {join,status,leave}` must attach `Authorization: Bearer <pat>`
 * on every server-bound call. The relay `/auth/token` call is intentionally
 * unauthenticated (shared secret pattern) and must stay that way.
 *
 * `resolveToken()` memoizes for the lifetime of the process, so each test
 * calls `resetTokenCache()` after mutating env to keep results deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSyncCommand } from '../commands/sync.js';
import { resetTokenCache } from '../lib/resolve-token.js';

const ORIG_ENV = { ...process.env };

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

let fetchMock: ReturnType<typeof vi.fn>;
let captured: CapturedRequest[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function makeFakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const initObj: RequestInit = init ?? {};
    captured.push({ url: u, init: initObj });
    return handler(u, initObj);
  });
}

function getHeader(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry[0]?.toLowerCase() === name.toLowerCase()) {
        return entry[1];
      }
    }
    return undefined;
  }
  // Plain object.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      const value = (headers as Record<string, string>)[key];
      return typeof value === 'string' ? value : undefined;
    }
  }
  return undefined;
}

async function runSync(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSyncCommand(program);
  await program.parseAsync(['node', 'brain', 'sync', ...args]);
}

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  // Pin the resolver to a deterministic env-only token so we don't touch the
  // host's keychain / real credentials files during tests.
  process.env.BRAIN_AUTH_TOKEN = 'pat-test-token';
  process.env.BRAIN_API_URL = 'http://server.test';
  resetTokenCache();

  captured = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('process.exit');
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIG_ENV };
  resetTokenCache();
});

describe('brain sync status', () => {
  it('attaches Authorization: Bearer <pat> on /api/sync/status', async () => {
    fetchMock = makeFakeFetch(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runSync(['status']);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('http://server.test/api/sync/status');
    expect(getHeader(captured[0].init, 'authorization')).toBe('Bearer pat-test-token');
    // sanity: empty-list path was hit
    expect(logSpy).toHaveBeenCalledWith('No synced namespaces.');
  });
});

describe('brain sync join', () => {
  it('relay /auth/token call is unauthenticated; server /api/sync/join carries the bearer', async () => {
    fetchMock = makeFakeFetch(async (url) => {
      if (url.endsWith('/auth/token')) {
        return new Response(JSON.stringify({ token: 'relay-jwt' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // /api/sync/join
      return new Response(
        JSON.stringify({
          namespace: 'team-x',
          state: 'connecting',
          connectedPeers: 0,
          lastSyncedAt: null,
          error: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await runSync([
      'join',
      '--namespace',
      'team-x',
      '--relay',
      'ws://relay.test',
      '--secret',
      'shared-relay-secret',
    ]);

    expect(captured).toHaveLength(2);

    // Call 1 — relay token mint: no Authorization header.
    expect(captured[0].url).toBe('http://relay.test/auth/token');
    expect(getHeader(captured[0].init, 'authorization')).toBeUndefined();
    const tokenBody = JSON.parse(
      typeof captured[0].init.body === 'string' ? captured[0].init.body : '',
    );
    expect(tokenBody.namespace).toBe('team-x');
    expect(tokenBody.secret).toBe('shared-relay-secret');

    // Call 2 — server join: bearer required.
    expect(captured[1].url).toBe('http://server.test/api/sync/join');
    expect(captured[1].init.method).toBe('POST');
    expect(getHeader(captured[1].init, 'authorization')).toBe('Bearer pat-test-token');
    expect(getHeader(captured[1].init, 'content-type')).toBe('application/json');
    const joinBody = JSON.parse(
      typeof captured[1].init.body === 'string' ? captured[1].init.body : '',
    );
    expect(joinBody.namespace).toBe('team-x');
    expect(joinBody.relayUrl).toBe('ws://relay.test');
    expect(joinBody.token).toBe('relay-jwt');
  });
});

describe('brain sync leave', () => {
  it('attaches Authorization: Bearer <pat> on /api/sync/leave', async () => {
    fetchMock = makeFakeFetch(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runSync(['leave', '--namespace', 'team-x']);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('http://server.test/api/sync/leave');
    expect(captured[0].init.method).toBe('POST');
    expect(getHeader(captured[0].init, 'authorization')).toBe('Bearer pat-test-token');
    expect(getHeader(captured[0].init, 'content-type')).toBe('application/json');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
