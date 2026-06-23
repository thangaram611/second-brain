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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerSyncCommand, resolveSyncJoinConfig } from '../commands/sync.js';
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
let origCwd: string;
let tmpRepo: string | null;

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
  // Plain object: read via a Record<string, unknown> view, then narrow with typeof.
  const record: Record<string, unknown> = { ...headers };
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      const value = record[key];
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

/**
 * Fake-fetch handler for the two-call join flow: mint a relay JWT on
 * `/auth/token`, then echo a sync status from `/api/sync/join`.
 */
function joinFetchHandler(
  statusNamespace: string,
): (url: string) => Promise<Response> {
  return async (url: string): Promise<Response> => {
    if (url.endsWith('/auth/token')) {
      return new Response(JSON.stringify({ token: 'relay-jwt' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        namespace: statusNamespace,
        state: 'connecting',
        connectedPeers: 0,
        lastSyncedAt: null,
        error: null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

/** Create a temp git repo containing `.second-brain/team.json` with `raw`. */
function makeRepoWithRawManifest(raw: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-manifest-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const dir = path.join(repo, '.second-brain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), raw);
  tmpRepo = repo;
  return repo;
}

function makeRepoWithManifest(manifest: unknown): string {
  return makeRepoWithRawManifest(JSON.stringify(manifest));
}

/** Create a temp git repo with no manifest (legitimate solo path). */
function makeEmptyRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-norepo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  tmpRepo = repo;
  return repo;
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpRepo = null;
  process.env = { ...ORIG_ENV };
  // Pin the resolver to a deterministic env-only token so we don't touch the
  // host's keychain / real credentials files during tests.
  process.env.BRAIN_AUTH_TOKEN = 'pat-test-token';
  process.env.BRAIN_API_URL = 'http://server.test';
  resetTokenCache();

  captured = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitImpl: (code?: number | string | null | undefined) => never = () => {
    throw new Error('process.exit');
  };
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(exitImpl);
});

afterEach(() => {
  // Restore cwd before removing the temp repo — never rm the dir we're in.
  process.chdir(origCwd);
  if (tmpRepo) {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    tmpRepo = null;
  }
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

  it('resolves namespace and relay from team.json when flags are omitted', async () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'manifest-ns',
      server: { url: 'http://server.test', relayUrl: 'ws://relay.test' },
    });
    process.chdir(repo);
    fetchMock = makeFakeFetch(joinFetchHandler('manifest-ns'));
    vi.stubGlobal('fetch', fetchMock);

    await runSync(['join', '--secret', 'shared']);

    expect(captured).toHaveLength(2);

    // Relay token mint uses the manifest namespace + relay, still unauthenticated.
    expect(captured[0].url).toBe('http://relay.test/auth/token');
    expect(getHeader(captured[0].init, 'authorization')).toBeUndefined();
    const tokenBody = JSON.parse(
      typeof captured[0].init.body === 'string' ? captured[0].init.body : '',
    );
    expect(tokenBody.namespace).toBe('manifest-ns');
    expect(tokenBody.secret).toBe('shared');

    // Server join still carries the bearer and the manifest relay URL.
    expect(captured[1].url).toBe('http://server.test/api/sync/join');
    expect(getHeader(captured[1].init, 'authorization')).toBe('Bearer pat-test-token');
    const joinBody = JSON.parse(
      typeof captured[1].init.body === 'string' ? captured[1].init.body : '',
    );
    expect(joinBody.namespace).toBe('manifest-ns');
    expect(joinBody.relayUrl).toBe('ws://relay.test');
  });

  it('lets explicit flags override the manifest and converts wss to https', async () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'manifest-ns',
      server: { url: 'http://server.test', relayUrl: 'ws://relay.test' },
    });
    process.chdir(repo);
    fetchMock = makeFakeFetch(joinFetchHandler('override-ns'));
    vi.stubGlobal('fetch', fetchMock);

    await runSync([
      'join',
      '--namespace', 'override-ns',
      '--relay', 'wss://override.test',
      '--secret', 'shared',
    ]);

    expect(captured[0].url).toBe('https://override.test/auth/token');
    const tokenBody = JSON.parse(
      typeof captured[0].init.body === 'string' ? captured[0].init.body : '',
    );
    expect(tokenBody.namespace).toBe('override-ns');
    const joinBody = JSON.parse(
      typeof captured[1].init.body === 'string' ? captured[1].init.body : '',
    );
    expect(joinBody.namespace).toBe('override-ns');
    expect(joinBody.relayUrl).toBe('wss://override.test');
  });

  it('exits with the secret error when no secret is available', async () => {
    delete process.env.RELAY_AUTH_SECRET;
    await expect(
      runSync(['join', '--namespace', 'team-x', '--relay', 'ws://relay.test']),
    ).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith(
      'Error: --secret or RELAY_AUTH_SECRET required',
    );
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

describe('resolveSyncJoinConfig', () => {
  it('fills namespace and relay from team.json when both flags are omitted', () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'manifest-ns',
      server: { url: 'http://server.test', relayUrl: 'ws://relay.test' },
    });
    const resolved = resolveSyncJoinConfig({ cwd: repo, secret: 'shared', env: {} });
    expect(resolved.namespace).toBe('manifest-ns');
    expect(resolved.relay).toBe('ws://relay.test');
    expect(resolved.relayHttpUrl).toBe('http://relay.test');
    expect(resolved.secret).toBe('shared');
  });

  it('lets explicit flags override manifest values', () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'manifest-ns',
      server: { url: 'http://server.test', relayUrl: 'ws://relay.test' },
    });
    const resolved = resolveSyncJoinConfig({
      cwd: repo,
      namespace: 'override-ns',
      relay: 'wss://override.test',
      secret: 'shared',
      env: {},
    });
    expect(resolved.namespace).toBe('override-ns');
    expect(resolved.relay).toBe('wss://override.test');
    expect(resolved.relayHttpUrl).toBe('https://override.test');
  });

  it('merges a single explicit flag with the manifest for the other value', () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'manifest-ns',
      server: { url: 'http://server.test', relayUrl: 'ws://relay.test' },
    });
    // --namespace explicit, --relay filled from the manifest.
    const a = resolveSyncJoinConfig({ cwd: repo, namespace: 'flag-ns', secret: 's', env: {} });
    expect(a.namespace).toBe('flag-ns');
    expect(a.relay).toBe('ws://relay.test');
    // --relay explicit, --namespace filled from the manifest.
    const b = resolveSyncJoinConfig({ cwd: repo, relay: 'wss://flag.test', secret: 's', env: {} });
    expect(b.namespace).toBe('manifest-ns');
    expect(b.relay).toBe('wss://flag.test');
    expect(b.relayHttpUrl).toBe('https://flag.test');
  });

  it('ignores a broken manifest when both flags are explicit', () => {
    // Fully-explicit invocations must not depend on a readable team.json.
    const repo = makeRepoWithRawManifest('{ not valid json');
    const resolved = resolveSyncJoinConfig({
      cwd: repo,
      namespace: 'team-x',
      relay: 'ws://relay.test',
      secret: 's',
      env: {},
    });
    expect(resolved.namespace).toBe('team-x');
    expect(resolved.relay).toBe('ws://relay.test');
  });

  it('reads the secret from RELAY_AUTH_SECRET when --secret is omitted', () => {
    const resolved = resolveSyncJoinConfig({
      namespace: 'team-x',
      relay: 'ws://relay.test',
      env: { RELAY_AUTH_SECRET: 'from-env' },
    });
    expect(resolved.secret).toBe('from-env');
  });

  it('throws the secret error when neither --secret nor RELAY_AUTH_SECRET is set', () => {
    expect(() =>
      resolveSyncJoinConfig({ namespace: 'team-x', relay: 'ws://relay.test', env: {} }),
    ).toThrow('--secret or RELAY_AUTH_SECRET required');
  });

  it('throws a missing-namespace error when no flag and no manifest supplies it', () => {
    const repo = makeEmptyRepo();
    expect(() =>
      resolveSyncJoinConfig({ cwd: repo, relay: 'ws://relay.test', secret: 's', env: {} }),
    ).toThrow('--namespace is required');
  });

  it('throws a missing-relay error when the manifest lacks server.relayUrl', () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'manifest-ns',
      server: { url: 'http://server.test' },
    });
    expect(() =>
      resolveSyncJoinConfig({ cwd: repo, secret: 's', env: {} }),
    ).toThrow('--relay is required');
  });

  it('refuses a broken (invalid JSON) manifest instead of falling back', () => {
    const repo = makeRepoWithRawManifest('{ not valid json');
    expect(() =>
      resolveSyncJoinConfig({ cwd: repo, secret: 's', env: {} }),
    ).toThrow(/invalid-json/);
  });

  it('refuses a broken (invalid schema) manifest instead of falling back', () => {
    const repo = makeRepoWithManifest({ version: 1, server: { url: 'http://server.test' } });
    expect(() =>
      resolveSyncJoinConfig({ cwd: repo, secret: 's', env: {} }),
    ).toThrow(/invalid-schema/);
  });

  it('refuses the personal namespace from an explicit flag', () => {
    expect(() =>
      resolveSyncJoinConfig({
        namespace: 'personal',
        relay: 'ws://relay.test',
        secret: 's',
        env: {},
      }),
    ).toThrow('Cannot sync the personal namespace');
  });

  it('refuses the personal namespace coming from the manifest', () => {
    const repo = makeRepoWithManifest({
      version: 1,
      namespace: 'personal',
      server: { url: 'http://server.test', relayUrl: 'ws://relay.test' },
    });
    expect(() =>
      resolveSyncJoinConfig({ cwd: repo, secret: 's', env: {} }),
    ).toThrow('Cannot sync the personal namespace');
  });

  it('rejects a relay URL that is not ws:// or wss://', () => {
    expect(() =>
      resolveSyncJoinConfig({
        namespace: 'team-x',
        relay: 'https://relay.test',
        secret: 's',
        env: {},
      }),
    ).toThrow(/must start with ws:\/\/ or wss:\/\//);
  });
});
