/**
 * Token resolver for hooks and CLI commands.
 *
 * Resolution order (PR2 §F + plan §F):
 *   1. `BRAIN_AUTH_TOKEN` env (legacy + CI escape hatch — bypasses keychain).
 *   2. `~/.second-brain/credentials/<host>.json` pointer + keychain entry
 *      keyed by the discriminated `pat:<host>:<tokenId>` account.
 *   3. None — caller decides whether to error or proceed unauthenticated.
 *
 * Memoized for the lifetime of the process: `brain-hook` invokes this on
 * every event, but a single Claude session fires many hooks and we must
 * not re-hit the keychain (UI prompt) on each one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { readSecret } from '../keychain.js';

export interface ResolveTokenOptions {
  /** Override host (defaults to URL parsed from env or 'localhost'). */
  host?: string;
  /** Override home dir (tests). */
  homeDir?: string;
  /** Skip memoization — for tests. */
  noCache?: boolean;
}

export interface ResolvedToken {
  token: string;
  source: 'env' | 'keychain';
  /** Token-id used to look up the keychain entry, when `source === 'keychain'`. */
  tokenId?: string;
}

const CredentialsSchema = z
  .object({
    serverUrl: z.string().optional(),
    namespace: z.string().optional(),
    userId: z.string().optional(),
    email: z.string().optional(),
    defaultTokenId: z.string().optional(),
    hookTokenId: z.string().optional(),
    cliTokenId: z.string().optional(),
    redeemedAt: z.string().optional(),
  })
  .passthrough();

export type Credentials = z.infer<typeof CredentialsSchema>;

let memo: { value: ResolvedToken | null; key: string } | null = null;

function memoKey(opts: ResolveTokenOptions): string {
  return `${opts.homeDir ?? ''}|${opts.host ?? ''}`;
}

export function resetTokenCache(): void {
  memo = null;
}

/** Build the keychain account string per plan §F. */
export function patAccount(host: string, tokenId: string): string {
  return `pat:${host}:${tokenId}`;
}

function resolveHost(explicit: string | undefined): string {
  if (explicit && explicit.length > 0) return explicit;
  // Try server URL envs in priority order.
  const candidate =
    process.env.BRAIN_API_URL ??
    process.env.BRAIN_SERVER_URL ??
    process.env.SECOND_BRAIN_SERVER_URL ??
    'http://localhost:7430';
  try {
    return new URL(candidate).host;
  } catch {
    return 'localhost';
  }
}

/** Read the credentials pointer file (non-secret). Returns null when absent or invalid. */
export function readCredentials(host: string, homeDir?: string): Credentials | null {
  const dir = path.join(homeDir ?? os.homedir(), '.second-brain', 'credentials');
  const file = path.join(dir, `${host}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = CredentialsSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a token without throwing. Returns null when nothing is available.
 * Used by `buildAuthHeaders()` and `brain-hook`.
 */
export async function resolveToken(opts: ResolveTokenOptions = {}): Promise<ResolvedToken | null> {
  const key = memoKey(opts);
  if (!opts.noCache && memo && memo.key === key) {
    return memo.value;
  }

  const envToken = process.env.BRAIN_AUTH_TOKEN;
  if (envToken && envToken.length > 0) {
    const out: ResolvedToken = { token: envToken, source: 'env' };
    if (!opts.noCache) memo = { value: out, key };
    return out;
  }

  const host = resolveHost(opts.host);
  const creds = readCredentials(host, opts.homeDir);
  if (!creds) {
    if (!opts.noCache) memo = { value: null, key };
    return null;
  }

  // Prefer hookTokenId for hook calls, then defaultTokenId, then cliTokenId.
  const tokenId =
    creds.hookTokenId ?? creds.defaultTokenId ?? creds.cliTokenId ?? null;
  if (!tokenId) {
    if (!opts.noCache) memo = { value: null, key };
    return null;
  }

  const account = patAccount(host, tokenId);
  const result = await readSecret(account);
  if (!result.ok || result.value === null || result.value === undefined) {
    if (!opts.noCache) memo = { value: null, key };
    return null;
  }
  const out: ResolvedToken = {
    token: result.value,
    source: 'keychain',
    tokenId,
  };
  if (!opts.noCache) memo = { value: out, key };
  return out;
}
