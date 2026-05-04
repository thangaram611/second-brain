import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runInitClient } from '../init-client.js';
import { setKeychainTestOverride, resetKeychainCache } from '../keychain.js';
import { readCredentials } from '../credentials.js';
import type { TeamManifest } from '../team-manifest.js';

let tmp: string;
let repo: string;
let stdoutBuf: string;
const sinkStdout = { write: (s: string): void => { stdoutBuf += s; } };

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-client-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-client-repo-'));
  stdoutBuf = '';
  resetKeychainCache();
  // Stub keychain with an in-memory store.
  const store = new Map<string, string>();
  setKeychainTestOverride({
    setPassword: async (_svc, account, pwd) => {
      store.set(account, pwd);
    },
    getPassword: async (_svc, account) => store.get(account) ?? null,
    deletePassword: async (_svc, account) => store.delete(account),
  });
  process.env.BRAIN_API_URL = 'http://localhost:7430';
  delete process.env.BRAIN_AUTH_TOKEN;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
  setKeychainTestOverride(null);
  resetKeychainCache();
});

function makeInvite(opts?: {
  ttlMs?: number;
  namespace?: string;
  expSeconds?: number;
}): string {
  const ns = opts?.namespace ?? 'team';
  const exp = opts?.expSeconds ?? Math.floor((Date.now() + (opts?.ttlMs ?? 60 * 60 * 1000)) / 1000);
  const payload = {
    jti: 'jti-' + Math.random().toString(16).slice(2, 10),
    namespace: ns,
    role: 'member',
    scopes: ['read', 'write'],
    exp,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Signature is irrelevant — server verifies; we only decode the payload.
  return `${payloadB64}.signature-placeholder`;
}

function makeFakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(u, init ?? {});
  }) as unknown as typeof fetch;
}

describe('runInitClient — fresh client (no manifest in cwd)', () => {
  it('redeems invite, stores PAT in keychain, writes credentials', async () => {
    const invite = makeInvite({ namespace: 'team-x' });
    const fetchImpl = makeFakeFetch(async (url) => {
      expect(url).toBe('http://localhost:7430/api/auth/redeem-invite');
      return new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_BCDEFGHIJKLMNOPQRSTUV234567ABCD',
          tokenId: 'aaaaaaaa',
          userId: 'usr_123',
          expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await runInitClient({
      invite,
      fetchImpl,
      homeDir: tmp,
      cwd: repo, // no manifest in this fresh repo
      stdout: sinkStdout,
      nonInteractive: true,
    });

    expect(result.host).toBe('localhost:7430');
    expect(result.namespace).toBe('team-x');
    expect(result.tokenId).toBe('aaaaaaaa');
    expect(result.patStored).toBe('keychain');
    expect(result.wiredRepoRoot).toBeNull();

    // Credentials persisted.
    const creds = readCredentials('localhost:7430', tmp);
    expect(creds).not.toBeNull();
    expect(creds!.namespace).toBe('team-x');
    expect(creds!.defaultTokenId).toBe('aaaaaaaa');

    // PAT NOT printed when storage succeeded.
    expect(stdoutBuf).not.toContain('sbp_aaaaaaaa');
  });

  it('rejects an expired invite client-side (fast UX)', async () => {
    const invite = makeInvite({ expSeconds: Math.floor(Date.now() / 1000) - 1 });
    const fetchImpl = makeFakeFetch(async () =>
      new Response('{}', { status: 200 }),
    );
    await expect(
      runInitClient({ invite, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout }),
    ).rejects.toThrow(/already expired/);
  });

  it('surfaces 409 already-consumed cleanly', async () => {
    const invite = makeInvite();
    const fetchImpl = makeFakeFetch(async () =>
      new Response('{"error":"invite-already-consumed"}', { status: 409 }),
    );
    await expect(
      runInitClient({ invite, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout }),
    ).rejects.toThrow(/already consumed/);
  });

  it('surfaces 400 invalid invite cleanly', async () => {
    const invite = makeInvite();
    const fetchImpl = makeFakeFetch(async () =>
      new Response('{"error":"invalid-invite"}', { status: 400 }),
    );
    await expect(
      runInitClient({ invite, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout }),
    ).rejects.toThrow(/invalid/);
  });

  it('refuses re-redemption when credentials already exist (without --refresh)', async () => {
    const invite = makeInvite();
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_AAAA',
          tokenId: 'aaaaaaaa',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    await runInitClient({ invite, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout, nonInteractive: true });
    const fresh = makeInvite();
    await expect(
      runInitClient({ invite: fresh, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout, nonInteractive: true }),
    ).rejects.toThrow(/already exist/);
  });

  it('--refresh allows overwriting existing credentials', async () => {
    const invite = makeInvite();
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_bbbbbbbb_BBBB',
          tokenId: 'bbbbbbbb',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    await runInitClient({ invite, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout, nonInteractive: true });
    const second = makeInvite();
    const result = await runInitClient({
      invite: second,
      fetchImpl,
      homeDir: tmp,
      cwd: repo,
      stdout: sinkStdout,
      refresh: true,
      nonInteractive: true,
    });
    expect(result.tokenId).toBe('bbbbbbbb');
  });

  it('rejects malformed invite payload', async () => {
    const fetchImpl = makeFakeFetch(async () => new Response('{}', { status: 201 }));
    await expect(
      runInitClient({ invite: 'not-base64.sig', fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout }),
    ).rejects.toThrow();
  });
});

describe('runInitClient — with team.json in cwd', () => {
  const MANIFEST: TeamManifest = {
    version: 1,
    namespace: 'team-graph',
    server: { url: 'http://localhost:7430' },
    hooks: { git: ['post-commit'], assistants: [], scope: 'user' },
  };

  function seedRepoWithManifest(): void {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.second-brain'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.second-brain', 'team.json'), JSON.stringify(MANIFEST));
  }

  it('non-interactive: auto-wires when manifest present', async () => {
    seedRepoWithManifest();
    const invite = makeInvite({ namespace: 'team-graph' });
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_AAAA',
          tokenId: 'aaaaaaaa',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    const result = await runInitClient({
      invite,
      fetchImpl,
      homeDir: tmp,
      cwd: repo,
      nonInteractive: true,
      stdout: sinkStdout,
    });
    expect(result.wiredRepoRoot).toBe(repo);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(true);
  });

  it('--no-wire skips wiring even when a manifest is present', async () => {
    seedRepoWithManifest();
    const invite = makeInvite({ namespace: 'team-graph' });
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_AAAA',
          tokenId: 'aaaaaaaa',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    const result = await runInitClient({
      invite,
      fetchImpl,
      homeDir: tmp,
      cwd: repo,
      wire: false,
      stdout: sinkStdout,
    });
    expect(result.wiredRepoRoot).toBeNull();
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('honors shouldWire prompt (interactive mock)', async () => {
    seedRepoWithManifest();
    const invite = makeInvite({ namespace: 'team-graph' });
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_AAAA',
          tokenId: 'aaaaaaaa',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    let asked = 0;
    const result = await runInitClient({
      invite,
      fetchImpl,
      homeDir: tmp,
      cwd: repo,
      stdout: sinkStdout,
      shouldWire: () => {
        asked++;
        return false;
      },
    });
    expect(asked).toBe(1);
    expect(result.wiredRepoRoot).toBeNull();
  });
});

describe('runInitClient — keychain failure handling', () => {
  it('throws when keychain fails AND plaintext fallback is not enabled', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'runtime-error',
      message: 'libsecret missing',
    });
    const invite = makeInvite();
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_AAAA',
          tokenId: 'aaaaaaaa',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    await expect(
      runInitClient({ invite, fetchImpl, homeDir: tmp, cwd: repo, stdout: sinkStdout }),
    ).rejects.toThrow(/keychain unavailable/);
  });

  it('falls back to plaintext when SECOND_BRAIN_ALLOW_PLAINTEXT_PAT=1 is set', async () => {
    process.env.SECOND_BRAIN_ALLOW_PLAINTEXT_PAT = '1';
    setKeychainTestOverride({
      ok: false,
      reason: 'runtime-error',
      message: 'libsecret missing',
    });
    const invite = makeInvite();
    const fetchImpl = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          pat: 'sbp_aaaaaaaa_AAAA',
          tokenId: 'aaaaaaaa',
          userId: 'usr_1',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    const result = await runInitClient({
      invite,
      fetchImpl,
      homeDir: tmp,
      cwd: repo,
      stdout: sinkStdout,
      nonInteractive: true,
    });
    expect(result.patStored).toBe('plaintext');
    expect(stdoutBuf).toContain('sbp_aaaaaaaa');
  });
});
