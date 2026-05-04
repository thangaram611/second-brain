/**
 * `brain admin` commands (PR4 §E).
 *
 *   brain admin invite [--namespace ns] [--ttl 24h] [--role member|admin] [--scopes read,write]
 *   brain admin token list [--user <email>]
 *   brain admin token revoke <token-id>
 *
 * All commands require an admin PAT in the resolver chain (env / keychain).
 * Each is a thin HTTP wrapper — no business logic lives client-side.
 */

import { z } from 'zod';
import { getServerUrl, buildAuthHeadersAsync } from './lib/config.js';

export interface AdminInviteOptions {
  namespace: string;
  ttl?: string;
  role?: 'member' | 'admin';
  scopes?: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface AdminInviteResult {
  invite: string;
  jti: string;
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
}

const InviteResponseSchema = z.object({
  invite: z.string(),
  jti: z.string(),
  expiresAt: z.number().int(),
});

const TokenListResponseSchema = z.object({
  tokens: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      label: z.string().nullable(),
      scopes: z.array(z.enum(['hook:read', 'read', 'write', 'admin'])),
      namespace: z.string().nullable(),
      createdAt: z.number().int(),
      lastUsedAt: z.number().int().nullable(),
      expiresAt: z.number().int().nullable(),
      revokedAt: z.number().int().nullable(),
    }),
  ),
});

export type AdminTokenRecord = z.infer<typeof TokenListResponseSchema>['tokens'][number];

const SCOPE_SET = new Set(['hook:read', 'read', 'write', 'admin']);

const TTL_REGEX = /^(\d+)\s*(ms|s|m|h|d)?$/i;

/** Parse a TTL string like "24h", "30m", "7d", or a plain number of ms. */
export function parseTtlMs(input: string): number {
  const m = TTL_REGEX.exec(input.trim());
  if (!m) {
    throw new Error(`invalid TTL: ${JSON.stringify(input)} (expected like "24h", "7d", "30m", or "3600s")`);
  }
  const n = Number(m[1]);
  // The regex already restricted m[1] to one or more decimal digits, so
  // n is a non-negative integer. Guard against overflow above MAX_SAFE_INTEGER
  // and against the trivial `0d` / `0h` / `0` cases.
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`invalid TTL value: ${input}`);
  }
  const unit = (m[2] ?? 'ms').toLowerCase();
  let multiplier: number;
  switch (unit) {
    case 'ms':
      multiplier = 1;
      break;
    case 's':
      multiplier = 1_000;
      break;
    case 'm':
      multiplier = 60_000;
      break;
    case 'h':
      multiplier = 3_600_000;
      break;
    case 'd':
      multiplier = 86_400_000;
      break;
    default:
      throw new Error(`unknown TTL unit: ${unit}`);
  }
  const ms = n * multiplier;
  if (!Number.isSafeInteger(ms)) {
    throw new Error(
      `TTL overflows safe integer range: ${input} → ${ms}ms (max ≈ ${Number.MAX_SAFE_INTEGER}ms ≈ 285k years)`,
    );
  }
  return ms;
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) return ['read', 'write'];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const p of parts) {
    if (!SCOPE_SET.has(p)) {
      throw new Error(`unknown scope: ${p} (allowed: hook:read, read, write, admin)`);
    }
  }
  return parts;
}

async function fetchWithError(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `${init.method ?? 'GET'} ${url} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
    );
  }
  return res;
}

/** Mint a single-use invite token. */
export async function adminInvite(opts: AdminInviteOptions): Promise<AdminInviteResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const serverUrl = getServerUrl(opts.serverUrl);
  const ttlMs = parseTtlMs(opts.ttl ?? '24h');
  const scopes = parseScopes(opts.scopes);
  const headers = await buildAuthHeadersAsync();

  const res = await fetchWithError(fetchImpl, `${serverUrl}/api/admin/invites`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      namespace: opts.namespace,
      role: opts.role ?? 'member',
      scopes,
      ttlMs,
    }),
  });
  const json: unknown = await res.json();
  return InviteResponseSchema.parse(json);
}

export interface AdminTokenListOptions {
  email: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}

/** List a user's tokens (admin only). Never returns secret material. */
export async function adminTokenList(opts: AdminTokenListOptions): Promise<AdminTokenRecord[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const serverUrl = getServerUrl(opts.serverUrl);
  const headers = await buildAuthHeadersAsync();
  const url = `${serverUrl}/api/admin/tokens?email=${encodeURIComponent(opts.email)}`;
  const res = await fetchWithError(fetchImpl, url, { method: 'GET', headers });
  const json: unknown = await res.json();
  return TokenListResponseSchema.parse(json).tokens;
}

export interface AdminTokenRevokeOptions {
  tokenId: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Revoke a single token by id. Returns true on success, throws on HTTP error. */
export async function adminTokenRevoke(opts: AdminTokenRevokeOptions): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const serverUrl = getServerUrl(opts.serverUrl);
  const headers = await buildAuthHeadersAsync();
  const url = `${serverUrl}/api/admin/tokens/${encodeURIComponent(opts.tokenId)}`;
  const res = await fetchWithError(fetchImpl, url, { method: 'DELETE', headers });
  return res.status === 204;
}
