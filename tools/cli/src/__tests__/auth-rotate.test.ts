import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runAuthRotate, AUTH_ROTATE_ENV_FALLBACK_EXIT_CODE } from '../auth-rotate.js';
import { resolveToken, resetTokenCache } from '../lib/resolve-token.js';
import { setKeychainTestOverride, resetKeychainCache } from '../keychain.js';
import { setMacKeychainProbeForTest, resetMacKeychainProbeCache } from '../probe-mac-keychain.js';
import { writeCredentials, readCredentials, type CredentialsRecord } from '../credentials.js';

const ORIG_ENV = { ...process.env };

let tmp: string;
let stdoutBuf: string;
let stderrBuf: string;
const sinkStdout = { write: (s: string): void => { stdoutBuf += s; } };
const sinkStderr = { write: (s: string): void => { stderrBuf += s; } };

let store: Map<string, string>;

function installFakeKeychain(): void {
  store = new Map<string, string>();
  setKeychainTestOverride({
    setPassword: async (_svc, account, pwd) => {
      store.set(account, pwd);
    },
    getPassword: async (_svc, account) => store.get(account) ?? null,
    deletePassword: async (_svc, account) => store.delete(account),
  });
}

function makeFakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(u, init ?? {});
  }) as unknown as typeof fetch;
}

function baseRecord(overrides: Partial<CredentialsRecord> = {}): CredentialsRecord {
  return {
    serverUrl: 'http://server.test',
    namespace: 'team-x',
    userId: 'usr_1',
    email: 'a@b.test',
    defaultTokenId: 'defaulta',
    redeemedAt: '2026-05-01T00:00:00.000Z',
    patExpiresAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-auth-rotate-'));
  stdoutBuf = '';
  stderrBuf = '';
  resetKeychainCache();
  resetTokenCache();
  resetMacKeychainProbeCache();
  // These tests exercise the keychain backend path — pre-pass the macOS
  // probe so the dispatcher routes through the injected fake keychain
  // instead of the file-store fallback.
  setMacKeychainProbeForTest(true);
  installFakeKeychain();
  process.env.BRAIN_API_URL = 'http://server.test';
  delete process.env.BRAIN_AUTH_TOKEN;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
  setKeychainTestOverride(null);
  setMacKeychainProbeForTest(null);
  resetKeychainCache();
  resetMacKeychainProbeCache();
  resetTokenCache();
});

describe('resolveToken — slot annotation', () => {
  it('returns slot=hook when hookTokenId is set', async () => {
    writeCredentials(
      'server.test',
      baseRecord({ hookTokenId: 'hookaaaa', defaultTokenId: 'defaulta', cliTokenId: 'cliaaaaa' }),
      tmp,
    );
    store.set('pat:server.test:hookaaaa', 'sbp_hook');
    const out = await resolveToken({ host: 'server.test', homeDir: tmp, noCache: true });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('keychain');
    expect(out!.tokenId).toBe('hookaaaa');
    expect(out!.slot).toBe('hook');
  });

  it('returns slot=default when only defaultTokenId is set', async () => {
    writeCredentials('server.test', baseRecord({ defaultTokenId: 'defaulta' }), tmp);
    store.set('pat:server.test:defaulta', 'sbp_default');
    const out = await resolveToken({ host: 'server.test', homeDir: tmp, noCache: true });
    expect(out).not.toBeNull();
    expect(out!.slot).toBe('default');
    expect(out!.tokenId).toBe('defaulta');
  });

  it('returns slot=cli when only cliTokenId is set', async () => {
    // Bypass strict schema: write a manual credentials JSON with only cliTokenId.
    // The strict writer requires defaultTokenId; the resolver tolerates absent
    // defaults to support legacy / hand-edited files.
    const dir = path.join(tmp, '.second-brain', 'credentials');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'server.test.json'),
      JSON.stringify({
        serverUrl: 'http://server.test',
        namespace: 'team-x',
        userId: 'usr_1',
        email: 'a@b.test',
        cliTokenId: 'cliaaaaa',
        redeemedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    store.set('pat:server.test:cliaaaaa', 'sbp_cli');
    const out = await resolveToken({ host: 'server.test', homeDir: tmp, noCache: true });
    expect(out).not.toBeNull();
    expect(out!.slot).toBe('cli');
    expect(out!.tokenId).toBe('cliaaaaa');
  });

  it('returns no slot when source is env', async () => {
    process.env.BRAIN_AUTH_TOKEN = 'env-pat';
    const out = await resolveToken({ host: 'server.test', homeDir: tmp, noCache: true });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('env');
    expect(out!.slot).toBeUndefined();
    expect(out!.tokenId).toBeUndefined();
  });
});

describe('runAuthRotate — keychain rotation', () => {
  it('updates only the originating slot pointer; preserves other slots', async () => {
    // Three distinct slot pointers; each maps to its own keychain entry.
    writeCredentials(
      'server.test',
      baseRecord({
        hookTokenId: 'hookaaaa',
        defaultTokenId: 'defaulta',
        cliTokenId: 'cliaaaaa',
      }),
      tmp,
    );
    store.set('pat:server.test:hookaaaa', 'sbp_hook');
    store.set('pat:server.test:defaulta', 'sbp_default');
    store.set('pat:server.test:cliaaaaa', 'sbp_cli');

    let captured: { url: string; auth: string; body: string } | null = null;
    const fetchImpl = makeFakeFetch(async (url, init) => {
      const headers = init.headers as Record<string, string>;
      captured = {
        url,
        auth: headers.Authorization ?? '',
        body: typeof init.body === 'string' ? init.body : '',
      };
      return new Response(
        JSON.stringify({
          pat: 'sbp_new_hook',
          tokenId: 'newhookid',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });

    const outcome = await runAuthRotate({
      fetchImpl,
      homeDir: tmp,
      host: 'server.test',
      stdout: sinkStdout,
      stderr: sinkStderr,
    });

    expect(outcome.kind).toBe('keychain');
    if (outcome.kind === 'keychain') {
      expect(outcome.slot).toBe('hook');
      expect(outcome.oldTokenId).toBe('hookaaaa');
      expect(outcome.newTokenId).toBe('newhookid');
    }
    // Server saw the OLD hook PAT as bearer.
    expect(captured!.auth).toBe('Bearer sbp_hook');
    expect(captured!.url).toBe('http://server.test/api/auth/rotate');

    // Credentials: ONLY hookTokenId changed; default + cli untouched.
    const creds = readCredentials('server.test', tmp);
    expect(creds).not.toBeNull();
    expect(creds!.hookTokenId).toBe('newhookid');
    expect(creds!.defaultTokenId).toBe('defaulta');
    expect(creds!.cliTokenId).toBe('cliaaaaa');
    expect(creds!.patExpiresAt).toBe('2026-09-01T00:00:00.000Z');

    // Keychain: new entry present, old hook entry removed; default+cli intact.
    expect(store.get('pat:server.test:newhookid')).toBe('sbp_new_hook');
    expect(store.get('pat:server.test:hookaaaa')).toBeUndefined();
    expect(store.get('pat:server.test:defaulta')).toBe('sbp_default');
    expect(store.get('pat:server.test:cliaaaaa')).toBe('sbp_cli');
  });

  it('emits a slot-warning message naming the slot that fired (hook session UX)', async () => {
    writeCredentials(
      'server.test',
      baseRecord({
        hookTokenId: 'hookaaaa',
        defaultTokenId: 'defaulta',
      }),
      tmp,
    );
    store.set('pat:server.test:hookaaaa', 'sbp_hook');
    store.set('pat:server.test:defaulta', 'sbp_default');

    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_newpat',
          tokenId: 'newhookid',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        { status: 201 },
      ),
    );

    await runAuthRotate({
      fetchImpl,
      homeDir: tmp,
      host: 'server.test',
      stdout: sinkStdout,
      stderr: sinkStderr,
    });

    expect(stderrBuf).toContain("rotating slot 'hook'");
    expect(stdoutBuf).toContain("rotated PAT for slot 'hook'");
  });

  it('handles 401 (revoked PAT) cleanly with an actionable error', async () => {
    writeCredentials('server.test', baseRecord({ defaultTokenId: 'defaulta' }), tmp);
    store.set('pat:server.test:defaulta', 'sbp_default');

    const fetchImpl = makeFakeFetch(async () =>
      new Response('"unauthorized"', { status: 401, statusText: 'Unauthorized' }),
    );

    await expect(
      runAuthRotate({
        fetchImpl,
        homeDir: tmp,
        host: 'server.test',
        stdout: sinkStdout,
        stderr: sinkStderr,
      }),
    ).rejects.toThrow(/401/);
    await expect(
      runAuthRotate({
        fetchImpl,
        homeDir: tmp,
        host: 'server.test',
        stdout: sinkStdout,
        stderr: sinkStderr,
      }),
    ).rejects.toThrow(/brain init client --refresh/);
  });

  it('--slot=cli overrides the resolver-chosen slot (hook) and updates only cli', async () => {
    writeCredentials(
      'server.test',
      baseRecord({
        hookTokenId: 'hookaaaa',
        defaultTokenId: 'defaulta',
        cliTokenId: 'cliaaaaa',
      }),
      tmp,
    );
    store.set('pat:server.test:hookaaaa', 'sbp_hook');
    store.set('pat:server.test:defaulta', 'sbp_default');
    store.set('pat:server.test:cliaaaaa', 'sbp_cli');

    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_new_cli',
          tokenId: 'newcliiid',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        { status: 201 },
      ),
    );

    const outcome = await runAuthRotate({
      slot: 'cli',
      fetchImpl,
      homeDir: tmp,
      host: 'server.test',
      stdout: sinkStdout,
      stderr: sinkStderr,
    });

    expect(outcome.kind).toBe('keychain');
    if (outcome.kind === 'keychain') {
      expect(outcome.slot).toBe('cli');
      expect(outcome.oldTokenId).toBe('cliaaaaa');
    }

    const creds = readCredentials('server.test', tmp);
    expect(creds).not.toBeNull();
    // CLI slot updated; hook + default unchanged.
    expect(creds!.cliTokenId).toBe('newcliiid');
    expect(creds!.hookTokenId).toBe('hookaaaa');
    expect(creds!.defaultTokenId).toBe('defaulta');

    // Keychain: new cli entry; old cli entry deleted; hook entry untouched.
    expect(store.get('pat:server.test:newcliiid')).toBe('sbp_new_cli');
    expect(store.get('pat:server.test:cliaaaaa')).toBeUndefined();
    expect(store.get('pat:server.test:hookaaaa')).toBe('sbp_hook');
    expect(stderrBuf).toContain('--slot=cli overrides resolver slot=hook');
  });

  it('preserves a shared old keychain entry when another slot still references it', async () => {
    // Edge case: hook + default share one tokenId. After rotating hook, the
    // shared keychain entry must NOT be deleted because default still points
    // at it.
    writeCredentials(
      'server.test',
      baseRecord({
        hookTokenId: 'sharedid',
        defaultTokenId: 'sharedid',
      }),
      tmp,
    );
    store.set('pat:server.test:sharedid', 'sbp_shared');

    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_new_hook',
          tokenId: 'newhookid',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        { status: 201 },
      ),
    );

    await runAuthRotate({
      fetchImpl,
      homeDir: tmp,
      host: 'server.test',
      stdout: sinkStdout,
      stderr: sinkStderr,
    });

    // Shared entry preserved (default still references it).
    expect(store.get('pat:server.test:sharedid')).toBe('sbp_shared');
    expect(store.get('pat:server.test:newhookid')).toBe('sbp_new_hook');

    const creds = readCredentials('server.test', tmp);
    expect(creds!.hookTokenId).toBe('newhookid');
    expect(creds!.defaultTokenId).toBe('sharedid');
  });
});

describe('runAuthRotate — env source', () => {
  it('prints PAT + instruction and returns exit code 2 (no keychain mutation)', async () => {
    process.env.BRAIN_AUTH_TOKEN = 'env-pat';

    const fetchImpl = makeFakeFetch(async (url, init) => {
      // Verify the bearer is the env token, not a keychain one.
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer env-pat');
      expect(url).toBe('http://server.test/api/auth/rotate');
      return new Response(
        JSON.stringify({
          pat: 'sbp_freshly_minted',
          tokenId: 'newenvid',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        { status: 201 },
      );
    });

    const outcome = await runAuthRotate({
      fetchImpl,
      homeDir: tmp,
      host: 'server.test',
      stdout: sinkStdout,
      stderr: sinkStderr,
    });

    expect(outcome.kind).toBe('env');
    if (outcome.kind === 'env') {
      expect(outcome.exitCode).toBe(AUTH_ROTATE_ENV_FALLBACK_EXIT_CODE);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.pat).toBe('sbp_freshly_minted');
      expect(outcome.newTokenId).toBe('newenvid');
    }

    // Stdout shows the PAT + the export instruction.
    expect(stdoutBuf).toContain('sbp_freshly_minted');
    expect(stdoutBuf).toContain('export BRAIN_AUTH_TOKEN=sbp_freshly_minted');
    // No credentials file should have been touched (none existed).
    expect(readCredentials('server.test', tmp)).toBeNull();
    // No keychain entries should have been created.
    expect(store.size).toBe(0);
  });
});

describe('runAuthRotate — error paths', () => {
  it('throws when no current token is resolvable', async () => {
    // No env token, no credentials file.
    await expect(
      runAuthRotate({
        homeDir: tmp,
        host: 'server.test',
        stdout: sinkStdout,
        stderr: sinkStderr,
      }),
    ).rejects.toThrow(/no current token/);
  });

  it('throws when the server response shape is malformed', async () => {
    writeCredentials('server.test', baseRecord({ defaultTokenId: 'defaulta' }), tmp);
    store.set('pat:server.test:defaulta', 'sbp_default');
    const fetchImpl = makeFakeFetch(async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 201 }),
    );
    await expect(
      runAuthRotate({
        fetchImpl,
        homeDir: tmp,
        host: 'server.test',
        stdout: sinkStdout,
        stderr: sinkStderr,
      }),
    ).rejects.toThrow();
  });

  it('surfaces actionable recovery info when patchCredentials fails after server+keychain succeeded', async () => {
    // Set up a normal credentials + keychain entry so the early readCredentials
    // guard, the network round-trip, and the keychain storeSecret all succeed.
    // We then trigger the patchCredentials failure path by corrupting the
    // credentials file from inside the fake setPassword callback — the new
    // keychain entry write happens AFTER the early readCredentials guard but
    // BEFORE patchCredentials' raw read, so this exercises the recovery
    // handler exactly as a real "mid-rotation disk failure" would.
    writeCredentials(
      'server.test',
      baseRecord({ defaultTokenId: 'defaulta' }),
      tmp,
    );
    store.set('pat:server.test:defaulta', 'sbp_default');
    const credsFile = path.join(
      tmp,
      '.second-brain',
      'credentials',
      'server.test.json',
    );

    // Override the keychain with a stub that corrupts the credentials file
    // when storing the NEW token (account contains the new tokenId).
    setKeychainTestOverride({
      setPassword: async (_svc, account, pwd) => {
        store.set(account, pwd);
        if (account.includes('recoverid')) {
          fs.writeFileSync(credsFile, '{ broken-after-keychain-write');
        }
      },
      getPassword: async (_svc, account) => store.get(account) ?? null,
      deletePassword: async (_svc, account) => store.delete(account),
    });

    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_recovered',
          tokenId: 'recoverid',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        { status: 201 },
      ),
    );

    await expect(
      runAuthRotate({
        fetchImpl,
        homeDir: tmp,
        host: 'server.test',
        stdout: sinkStdout,
        stderr: sinkStderr,
      }),
    ).rejects.toThrow(/not valid JSON/);

    // The new PAT is in the keychain even though the patch failed.
    expect(store.get('pat:server.test:recoverid')).toBe('sbp_recovered');

    // Recovery message contains the new tokenId AND the credentials path
    // AND the manual edit instructions.
    expect(stdoutBuf).toContain('pat:server.test:recoverid');
    expect(stdoutBuf).toContain('brain init client --refresh');
    expect(stdoutBuf).toContain('credentials/server.test.json');
    expect(stdoutBuf).toContain('defaultTokenId: "recoverid"');
  });
});
