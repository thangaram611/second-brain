/**
 * Section H end-to-end walkthrough — automated coverage (PR6 §6.6).
 *
 * Drives the parts of the 12-step manual walkthrough that are scriptable:
 *   1. `runInitServer` bootstrap (secrets, brain.db, users.db, service file,
 *      bootstrap admin PAT)
 *   2. Admin mints an invite using the same `UsersService` the server uses;
 *      invite is HMAC-signed with the bootstrapped invite signing key
 *   3. `runInitClient` redeems against an in-process fake-fetch backed by the
 *      real `UsersService` so PAT mint + user creation + namespace
 *      membership are exercised end-to-end
 *   4. Asserts: credentials file exists at `~/.second-brain/credentials/<host>.json`
 *      with mode 0600; keychain entry exists at `pat:<host>:<tokenId>`; the
 *      raw PAT was NOT printed to stdout (keychain success path)
 *   5. `runWireFromManifest` wires a tmp git repo and asserts:
 *      - assistant sidecars exist (cursor / codex / copilot at project scope)
 *      - sidecars reference the `brain-hook` binary
 *      - git hooks exist in `.git/hooks/` and carry the second-brain wire
 *        fingerprint + the team server URL
 *
 * Steps that can't be scripted are listed in `docs/manual-verification.md`:
 *   - Real Claude Code / Cursor / Codex / Copilot session opens that observe
 *     additionalContext injection
 *   - p95 latency in `~/.second-brain/hook.log`
 *   - Cap behavior at 9 vs 10 large injections in one session
 *   - `systemd-analyze security` against a rendered Linux unit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { runInitServer } from '../init-server.js';
import { runInitClient } from '../init-client.js';
import { runWireFromManifest } from '../wire.js';
import { setKeychainTestOverride, resetKeychainCache } from '../keychain.js';
import { setMacKeychainProbeForTest, resetMacKeychainProbeCache } from '../probe-mac-keychain.js';
import { readCredentials } from '../credentials.js';
import { UsersService, type Scope } from '@second-brain/server/services/users';
import type { TeamManifest } from '../team-manifest.js';

const ORIG_ENV = { ...process.env };

let tmpHome: string;
let tmpServerHome: string;
let repoRoot: string;
let stdoutBuf: string;
const sinkStdout = { write: (s: string): void => { stdoutBuf += s; } };

let store: Map<string, string>;
let savedHome: string | undefined;

function swapHome(newHome: string): void {
  savedHome = process.env.HOME;
  process.env.HOME = newHome;
}

function restoreHome(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  savedHome = undefined;
}

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

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-e2e-client-home-'));
  tmpServerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-e2e-server-home-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-e2e-repo-'));
  stdoutBuf = '';
  resetKeychainCache();
  installFakeKeychain();
  process.env.BRAIN_API_URL = 'http://localhost:7430';
  delete process.env.BRAIN_AUTH_TOKEN;
  // Redirect HOME so any code path that resolves `os.homedir()` (notably
  // `runWireFromManifest` and adapter installers) writes inside tmpHome
  // rather than the real `~`. With HOME swapped, the macOS `security`
  // probe can no longer find the user's real login keychain, so we also
  // inject a positive probe result — the fake keytar (set above) handles
  // the actual store/get, so backend selection ends up at 'keychain'.
  swapHome(tmpHome);
  resetMacKeychainProbeCache();
  setMacKeychainProbeForTest(true);
});

afterEach(() => {
  restoreHome();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpServerHome, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
  setKeychainTestOverride(null);
  resetKeychainCache();
  setMacKeychainProbeForTest(null);
  resetMacKeychainProbeCache();
});

// --- Invite signing helpers (mirrors apps/server/src/lib/invite.ts) --------

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signInvite(
  payload: {
    jti: string;
    namespace: string;
    role: 'member' | 'admin';
    scopes: readonly string[];
    exp: number;
  },
  signingKey: string,
): string {
  const json = JSON.stringify(payload);
  const encodedPayload = base64url(json);
  const sig = createHmac('sha256', signingKey).update(encodedPayload).digest();
  return `${encodedPayload}.${base64url(sig)}`;
}

function readSecret(secretsPath: string, key: string): string {
  const raw = fs.readFileSync(secretsPath, 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`secrets file missing ${key}`);
  return line.slice(key.length + 1);
}

// --- Tests -----------------------------------------------------------------

describe('Section H walkthrough — automated coverage', () => {
  it('init server → mint invite → init client → wire repo (full happy path)', async () => {
    // -----------------------------------------------------------------
    // 1. `brain init server` — bootstrap. We override every default path
    //    so the test is hermetic and parallel-safe.
    // -----------------------------------------------------------------
    // Force the `manual` (no-service-file) branch: pass an explicitly-
    // unrecognized platform so `defaultServicePath` returns null and
    // `runInitServer` skips both service-file writes. This keeps the test
    // hermetic — no launchd / systemd dirs touched, no chown / preflight.
    const serverResult = await runInitServer({
      platform: 'freebsd',
      homeDir: tmpServerHome,
      storageDir: path.join(tmpServerHome, 'data'),
      secretsPath: path.join(tmpServerHome, 'secrets.env'),
      port: 7430,
      relayPort: 7421,
      adminEmail: 'admin@e2e.test',
      adminPatTtl: '90d',
      nonInteractive: true,
      stdout: sinkStdout,
    });

    expect(fs.existsSync(serverResult.brainDbPath)).toBe(true);
    expect(fs.existsSync(serverResult.usersDbPath)).toBe(true);
    expect(fs.existsSync(serverResult.secretsPath)).toBe(true);
    expect(serverResult.adminPat).toMatch(/^sbp_/);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(serverResult.secretsPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // -----------------------------------------------------------------
    // 2. Mint an invite using the same UsersService the server uses, and
    //    sign it with the bootstrapped BRAIN_INVITE_SIGNING_KEY. This
    //    mirrors what `brain admin invite` does server-side.
    // -----------------------------------------------------------------
    const inviteSigningKey = readSecret(serverResult.secretsPath, 'BRAIN_INVITE_SIGNING_KEY');
    const usersDbPath = serverResult.usersDbPath;

    const usersForMint = new UsersService({ path: usersDbPath });
    const jti = randomBytes(12).toString('hex');
    const expSec = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const namespace = 'team-e2e';
    const inviteScopes: Scope[] = ['read', 'write'];
    usersForMint.insertInvite({
      jti,
      namespace,
      role: 'member',
      scopes: inviteScopes,
      expiresAt: expSec * 1000,
      consumedAt: null,
      signature: 'admin-minted',
      createdAt: Date.now(),
    });
    usersForMint.close();

    const invite = signInvite(
      { jti, namespace, role: 'member', scopes: ['read', 'write'], exp: expSec },
      inviteSigningKey,
    );

    // -----------------------------------------------------------------
    // 3. Drive `runInitClient` against a fake fetch that exercises the
    //    REAL UsersService.consumeInvite + upsertUser + mintPat. We
    //    cannot stand up the in-process Express app here without crossing
    //    package boundaries (apps/server doesn't export `createApp`), so
    //    we mirror the `redeem-invite` route's body directly. The
    //    user-facing client surface is identical; the server-side routing
    //    layer is covered by `apps/server/src/__tests__/auth.test.ts`.
    //
    //    The "fresh subprocess" form of this step is documented as a
    //    manual-verification step in `docs/manual-verification.md` —
    //    spawning `node dist/index.mjs init client ...` requires a real
    //    OS keychain, which CI does not have.
    // -----------------------------------------------------------------
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const expectedUrl = 'http://localhost:7430/api/auth/redeem-invite';
      if (u !== expectedUrl) {
        return Promise.resolve(
          new Response(`unexpected url ${u}`, { status: 500 }),
        );
      }
      const bodyStr =
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : '';
      const body = JSON.parse(bodyStr) as { invite: string };
      return (async () => {
        const usersForRedeem = new UsersService({ path: usersDbPath });
        try {
          const consumed = usersForRedeem.consumeInvite(jti);
          if (!consumed) {
            return new Response('"already-consumed"', { status: 409 });
          }
          // Sanity: the invite the client is sending should match the one
          // we minted.
          if (body.invite !== invite) {
            return new Response('"invite-mismatch"', { status: 400 });
          }
          const placeholderEmail = `${jti}@invite.local`;
          const user = usersForRedeem.upsertUser({
            email: placeholderEmail,
            role: 'member',
          });
          usersForRedeem.addNamespaceMembership({
            userId: user.id,
            namespace,
            role: 'member',
          });
          const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
          const minted = await usersForRedeem.mintPat({
            userId: user.id,
            label: 'invite-redeemed',
            scopes: inviteScopes,
            namespace,
            expiresAt,
          });
          return new Response(
            JSON.stringify({
              pat: minted.pat,
              tokenId: minted.tokenId,
              userId: user.id,
              expiresAt: new Date(expiresAt).toISOString(),
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          );
        } finally {
          usersForRedeem.close();
        }
      })();
    }) as unknown as typeof fetch;

    const clientResult = await runInitClient({
      invite,
      serverUrl: 'http://localhost:7430',
      fetchImpl,
      homeDir: tmpHome,
      cwd: repoRoot, // no manifest in this fresh repo
      nonInteractive: true,
      wire: false, // we drive wiring manually below
      stdout: sinkStdout,
    });

    expect(clientResult.host).toBe('localhost:7430');
    expect(clientResult.namespace).toBe('team-e2e');
    expect(clientResult.patStored).toBe('keychain');
    expect(clientResult.tokenId).toMatch(/^[a-z0-9]{8}$/);

    // -----------------------------------------------------------------
    // 4. Filesystem + keychain assertions.
    // -----------------------------------------------------------------
    const credsPath = clientResult.credentialsPath;
    expect(fs.existsSync(credsPath)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(credsPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const credsRecord = readCredentials('localhost:7430', tmpHome);
    expect(credsRecord).not.toBeNull();
    expect(credsRecord!.namespace).toBe('team-e2e');
    expect(credsRecord!.defaultTokenId).toBe(clientResult.tokenId);
    expect(credsRecord!.hookTokenId).toBe(clientResult.tokenId);
    expect(credsRecord!.cliTokenId).toBe(clientResult.tokenId);

    // Keychain entry created at the discriminated account.
    const account = `pat:localhost:7430:${clientResult.tokenId}`;
    expect(store.get(account)).toBe(clientResult.pat);

    // PAT NOT printed when keychain succeeded.
    expect(stdoutBuf).not.toContain(clientResult.pat);

    // -----------------------------------------------------------------
    // 5. Wire a tmp git repo via the manifest. Use project-scope so
    //    cursor/codex/copilot sidecars all land inside the repo (rather
    //    than ~/.cursor) — keeps the test hermetic.
    // -----------------------------------------------------------------
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    const manifest: TeamManifest = {
      version: 1,
      namespace: 'team-e2e',
      server: { url: 'http://localhost:7430' },
      hooks: {
        git: ['post-commit', 'post-merge', 'post-checkout'],
        assistants: ['cursor', 'codex', 'copilot'],
        scope: 'project',
      },
    };

    const wireResult = await runWireFromManifest({
      repoRoot,
      manifest,
    });

    expect(wireResult.namespace).toBe('team-e2e');
    expect(wireResult.installedAssistants).toEqual(
      expect.arrayContaining(['cursor', 'codex', 'copilot']),
    );
    expect(wireResult.installedGitHooks).not.toBeNull();
    expect(wireResult.installedGitHooks!.installed).toContain('post-commit');

    // -----------------------------------------------------------------
    // 6. Sidecar files exist + reference brain-hook.
    // -----------------------------------------------------------------
    const cursorHooks = path.join(repoRoot, '.cursor', 'hooks.json');
    const codexHooks = path.join(repoRoot, '.codex', 'hooks.json');
    const copilotHooks = path.join(repoRoot, '.github', 'hooks', 'second-brain.json');

    for (const sidecar of [cursorHooks, codexHooks, copilotHooks]) {
      expect(fs.existsSync(sidecar)).toBe(true);
      const body = fs.readFileSync(sidecar, 'utf8');
      expect(body).toContain('brain-hook');
    }

    // -----------------------------------------------------------------
    // 7. Git hook scripts in .git/hooks/ carry the second-brain
    //    fingerprint + the team server URL. (They invoke `curl` against
    //    the API directly; no `brain-hook` reference — the assistant
    //    sidecars above reference brain-hook for IDE-side hooks.)
    // -----------------------------------------------------------------
    for (const name of ['post-commit', 'post-merge', 'post-checkout']) {
      const hookPath = path.join(repoRoot, '.git', 'hooks', name);
      expect(fs.existsSync(hookPath)).toBe(true);
      const body = fs.readFileSync(hookPath, 'utf8');
      expect(body).toContain('Installed by second-brain');
      expect(body).toContain('http://localhost:7430');
      // Executable bit is set on POSIX.
      if (process.platform !== 'win32') {
        const mode = fs.statSync(hookPath).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
      }
    }
  }, 60_000);
});
