/**
 * `brain init client --invite <token>` (PR4 §D).
 *
 * Steps:
 *   1. Decode invite client-side (HMAC verify is server-side; we just
 *      sanity-check the shape + expiry for early UX).
 *   2. POST /api/auth/redeem-invite — receive { pat, tokenId, userId, expiresAt }.
 *   3. Store PAT in keychain at `pat:<host>:<tokenId>`. Plaintext fallback
 *      requires `SECOND_BRAIN_ALLOW_PLAINTEXT_PAT=1`.
 *   4. Write `~/.second-brain/credentials/<host>.json` (mode 0600).
 *   5. If cwd is inside a repo with `.second-brain/team.json`, prompt to wire.
 *      `--non-interactive` skips the prompt.
 *   6. Print summary; PAT is shown ONLY if keychain storage failed AND
 *      plaintext fallback was opted into.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { storeSecret } from './keychain.js';
import { writeCredentials, readCredentials } from './credentials.js';
import { loadTeamManifest } from './team-manifest.js';
import { runWireFromManifest } from './wire.js';

const RedeemResponseSchema = z.object({
  pat: z.string().min(8),
  tokenId: z.string().min(1),
  userId: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

type RedeemResponse = z.infer<typeof RedeemResponseSchema>;

const InvitePayloadSchema = z.object({
  jti: z.string(),
  namespace: z.string().min(1),
  role: z.enum(['member', 'admin']),
  scopes: z.array(z.string()).default([]),
  exp: z.number().int().positive(),
});

interface DecodedInvite {
  jti: string;
  namespace: string;
  role: 'member' | 'admin';
  scopes: string[];
  expSeconds: number;
}

export interface InitClientOptions {
  invite: string;
  /** Override the server URL — falls back to URL embedded in invite is N/A;
   *  invites do not embed server_url, so this MUST be set or BRAIN_API_URL must
   *  be exported. */
  serverUrl?: string;
  /** When true: never prompt; if a manifest is present we still wire (default
   *  behavior). Use `--no-wire` shape via `wire=false` to skip. */
  nonInteractive?: boolean;
  /** Force-overwrite an existing credentials file for this host. */
  refresh?: boolean;
  /** When false, never auto-wire even if a manifest is found. */
  wire?: boolean;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override HOME (tests). */
  homeDir?: string;
  /** Override cwd (tests). */
  cwd?: string;
  /** Stream destination (tests). */
  stdout?: { write(s: string): void };
  /**
   * For tests: a thunk that decides whether to wire when a manifest is
   * present. Defaults to `() => true` in the suite; in real CLI usage we
   * replace this with a clack prompt before calling runInitClient.
   */
  shouldWire?: (cwd: string, namespace: string) => boolean | Promise<boolean>;
}

export interface InitClientResult {
  host: string;
  serverUrl: string;
  namespace: string;
  userId: string;
  tokenId: string;
  pat: string;
  patStored: 'keychain' | 'plaintext';
  patStorageWarning: string | null;
  credentialsPath: string;
  wiredRepoRoot: string | null;
}

function decodeInvite(token: string): DecodedInvite {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('invite is malformed (expected "<payload>.<signature>")');
  }
  const [payloadB64] = parts;
  let json: string;
  try {
    json = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (payloadB64.length % 4)) % 4),
      'base64',
    ).toString('utf8');
  } catch (e) {
    throw new Error(
      `invite payload is not valid base64url: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(json);
  } catch {
    throw new Error('invite payload is not JSON');
  }
  const result = InvitePayloadSchema.safeParse(parsedUnknown);
  if (!result.success) {
    throw new Error(`invite payload schema mismatch: ${z.prettifyError(result.error)}`);
  }
  return {
    jti: result.data.jti,
    namespace: result.data.namespace,
    role: result.data.role,
    scopes: result.data.scopes,
    expSeconds: result.data.exp,
  };
}

function patAccount(host: string, tokenId: string): string {
  return `pat:${host}:${tokenId}`;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'localhost';
  }
}

function findRepoRoot(cwd: string): string | null {
  // Walk up from cwd looking for a `.git` directory or a `.second-brain` directory.
  let dir = path.resolve(cwd);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.second-brain'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function resolveServerUrl(opts: InitClientOptions): Promise<string> {
  if (opts.serverUrl) return opts.serverUrl;
  const env =
    process.env.BRAIN_API_URL ??
    process.env.BRAIN_SERVER_URL ??
    process.env.SECOND_BRAIN_SERVER_URL;
  if (env) return env;
  throw new Error(
    'no server URL — pass --server <url> or export BRAIN_API_URL.',
  );
}

export async function runInitClient(opts: InitClientOptions): Promise<InitClientResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stdout = opts.stdout ?? process.stdout;
  const homeOverride = opts.homeDir;
  const cwd = opts.cwd ?? process.cwd();

  // 1. Sanity-decode the invite for display + expiry guard.
  const decoded = decodeInvite(opts.invite);
  const nowSec = Math.floor(Date.now() / 1000);
  if (decoded.expSeconds <= nowSec) {
    throw new Error(
      `invite already expired at ${new Date(decoded.expSeconds * 1000).toISOString()}; ask your admin to re-mint.`,
    );
  }

  const serverUrl = await resolveServerUrl(opts);
  const host = hostFromUrl(serverUrl);

  // 2. Block re-redemption unless --refresh.
  if (!opts.refresh) {
    const existing = readCredentials(host, homeOverride);
    if (existing) {
      throw new Error(
        `credentials for ${host} already exist (${existing.email}). Pass --refresh to rotate.`,
      );
    }
  }

  // 3. POST /api/auth/redeem-invite.
  const res = await fetchImpl(`${serverUrl}/api/auth/redeem-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite: opts.invite }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    if (res.status === 409) {
      throw new Error(`invite already consumed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    if (res.status === 400) {
      throw new Error(`invite invalid (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    throw new Error(
      `redeem-invite failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  const json: unknown = await res.json();
  const parsed = RedeemResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`server response did not match expected shape: ${z.prettifyError(parsed.error)}`);
  }
  const redeemed: RedeemResponse = parsed.data;

  // 4. Store PAT in keychain — fall back to plaintext only when explicitly opted in.
  const account = patAccount(host, redeemed.tokenId);
  const stored = await storeSecret(account, redeemed.pat);
  let patStored: 'keychain' | 'plaintext';
  let patStorageWarning: string | null = null;
  if (stored.ok) {
    patStored = 'keychain';
  } else {
    // `stored` is structurally narrowed to KeychainUnavailable here — the
    // discriminated union exits the `ok: true` branch above.
    if (process.env.SECOND_BRAIN_ALLOW_PLAINTEXT_PAT === '1') {
      patStored = 'plaintext';
      patStorageWarning = `keychain unavailable (${stored.message}); using BRAIN_AUTH_TOKEN env fallback only.`;
    } else {
      throw new Error(
        `keychain unavailable (${stored.message}); ` +
          `re-run with SECOND_BRAIN_ALLOW_PLAINTEXT_PAT=1 to fall back to env-var, ` +
          `or fix the keychain (e.g., install libsecret on Linux) and try again.`,
      );
    }
  }

  // 5. Write credentials pointer file.
  const { path: credentialsPath } = writeCredentials(
    host,
    {
      serverUrl,
      namespace: decoded.namespace,
      userId: redeemed.userId,
      email: `${decoded.jti}@invite.local`, // server uses jti-derived placeholder
      defaultTokenId: redeemed.tokenId,
      hookTokenId: redeemed.tokenId,
      cliTokenId: redeemed.tokenId,
      redeemedAt: new Date().toISOString(),
      patExpiresAt: redeemed.expiresAt,
    },
    homeOverride,
  );

  // 6. If cwd is inside a repo with team.json, optionally wire it.
  let wiredRepoRoot: string | null = null;
  const wantWire = opts.wire !== false;
  if (wantWire) {
    const repoRoot = findRepoRoot(cwd);
    if (repoRoot) {
      const loaded = loadTeamManifest(repoRoot);
      if (loaded.ok) {
        let proceed = true;
        if (!opts.nonInteractive && opts.shouldWire) {
          proceed = await opts.shouldWire(repoRoot, loaded.manifest.namespace);
        }
        if (proceed) {
          await runWireFromManifest({
            repoRoot,
            manifest: loaded.manifest,
          });
          wiredRepoRoot = repoRoot;
        }
      }
    }
  }

  // 7. Summary.
  const lines = [
    '✓ second-brain client wired',
    '',
    `  host:           ${host}`,
    `  namespace:      ${decoded.namespace}`,
    `  user id:        ${redeemed.userId}`,
    `  token id:       ${redeemed.tokenId}`,
    `  PAT storage:    ${patStored}`,
  ];
  if (patStorageWarning) lines.push(`  warn:           ${patStorageWarning}`);
  if (patStored === 'plaintext') {
    lines.push(`  PAT (one-time): ${redeemed.pat}`);
    lines.push(`     — keychain failed; export BRAIN_AUTH_TOKEN with this value.`);
  }
  lines.push(`  credentials:    ${credentialsPath}`);
  lines.push(`  PAT expiry:     ${redeemed.expiresAt}`);
  if (wiredRepoRoot) {
    lines.push(`  wired repo:     ${wiredRepoRoot}`);
  }
  lines.push('', `  Try: brain status`, '');
  stdout.write(lines.join('\n'));

  return {
    host,
    serverUrl,
    namespace: decoded.namespace,
    userId: redeemed.userId,
    tokenId: redeemed.tokenId,
    pat: redeemed.pat,
    patStored,
    patStorageWarning,
    credentialsPath,
    wiredRepoRoot,
  };
}

/** Helper to form the keychain account string used by `brain init client`. */
export function buildPatAccount(host: string, tokenId: string): string {
  return patAccount(host, tokenId);
}
