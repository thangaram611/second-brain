/**
 * users.db sidecar — server-side identity, PATs, invites, and sessions.
 *
 * PAT format: `sbp_<8-char-id>_<32-char-base62-secret>_<6-char-base62-CRC32>`
 *   - The id is the primary key in `tokens`. The secret is hashed with
 *     argon2id and stored as `tokens.hash`.
 *   - The 6-char suffix is a base62-encoded CRC32 of the secret bytes — it
 *     mirrors GitHub's `github_pat_*` shape and exists purely as
 *     defense-in-depth (cheap forgery / typo detection so a malformed PAT is
 *     rejected before the deliberately-slow argon2id verify runs).
 *     **The CRC32 is NOT the auth gate.** Authentication remains the
 *     argon2id verify against `tokens.hash`.
 *   - Tokens optionally lock to a single namespace (`tokens.namespace`);
 *     a NULL namespace means "any namespace the user has membership for".
 *
 * Invites are single-use HMAC tokens; redemption sets `consumed_at` atomically
 * via `UPDATE ... WHERE consumed_at IS NULL` so concurrent redeem requests can
 * never both succeed.
 *
 * NOTE: This module does not import `@second-brain/core`. It uses
 * better-sqlite3 directly so the auth surface stays narrow and independent
 * of the knowledge-graph schema.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import * as argon2 from 'argon2';
import { z } from 'zod';

// --- Schema -----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('member','admin')),
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER
);

CREATE TABLE IF NOT EXISTS user_namespaces (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('member','admin')),
  PRIMARY KEY (user_id, namespace)
);

CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash          TEXT NOT NULL,
  label         TEXT,
  scopes        TEXT NOT NULL,
  namespace     TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id);

CREATE TABLE IF NOT EXISTS invites (
  jti          TEXT PRIMARY KEY,
  namespace    TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('member','admin')),
  scopes       TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  signature    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace   TEXT,
  expires_at  INTEGER NOT NULL,
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
`;

// --- Argon2id stretching params (env-configurable, see docs/tunings/argon2.md) ---

/**
 * OWASP-equivalent baselines (argon2id). Either profile is acceptable; reject
 * only when the operator-supplied params are below BOTH.
 *
 * Source: OWASP Password Storage Cheat Sheet (2025) + RFC 9106.
 */
const OWASP_BASELINE_HIGH_MEM = { memoryCost: 47_104, timeCost: 1, parallelism: 1 } as const; // ~46 MiB
const OWASP_BASELINE_LOW_MEM = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const; //  ~19 MiB

/**
 * Default mint params — m=64 MiB / t=3 / p=1.
 * - Matches OWASP recommendation, RFC 9106, node-argon2's own default, Bitwarden.
 * - p=1 (NOT p=4) avoids exhausting the libuv thread pool under concurrent logins.
 */
const DEFAULT_ARGON2_PARAMS = { memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

interface Argon2Params {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

const PositiveIntSchema = z.coerce.number().int().positive();

function parseEnvParam(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = PositiveIntSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${name}=${raw}: must be a positive integer. See docs/tunings/argon2.md.`,
    );
  }
  return parsed.data;
}

function readArgon2Params(): Argon2Params {
  return {
    memoryCost: parseEnvParam('BRAIN_ARGON2_M', DEFAULT_ARGON2_PARAMS.memoryCost),
    timeCost: parseEnvParam('BRAIN_ARGON2_T', DEFAULT_ARGON2_PARAMS.timeCost),
    parallelism: parseEnvParam('BRAIN_ARGON2_P', DEFAULT_ARGON2_PARAMS.parallelism),
  };
}

function meetsBaseline(p: Argon2Params, baseline: Argon2Params): boolean {
  return (
    p.memoryCost >= baseline.memoryCost &&
    p.timeCost >= baseline.timeCost &&
    p.parallelism >= baseline.parallelism
  );
}

function assertParamsMeetOwasp(p: Argon2Params): void {
  if (meetsBaseline(p, OWASP_BASELINE_HIGH_MEM) || meetsBaseline(p, OWASP_BASELINE_LOW_MEM)) {
    return;
  }
  throw new Error(
    `Argon2id params below both OWASP baselines (BRAIN_ARGON2_M=${p.memoryCost}, ` +
      `BRAIN_ARGON2_T=${p.timeCost}, BRAIN_ARGON2_P=${p.parallelism}). ` +
      `Required: (m≥${OWASP_BASELINE_HIGH_MEM.memoryCost} AND t≥${OWASP_BASELINE_HIGH_MEM.timeCost} AND p≥${OWASP_BASELINE_HIGH_MEM.parallelism}) ` +
      `OR (m≥${OWASP_BASELINE_LOW_MEM.memoryCost} AND t≥${OWASP_BASELINE_LOW_MEM.timeCost} AND p≥${OWASP_BASELINE_LOW_MEM.parallelism}). ` +
      `See docs/tunings/argon2.md.`,
  );
}

/**
 * Refuse-boot guard. Reads `BRAIN_ARGON2_*` and throws if the operator-supplied
 * params fall below BOTH OWASP baselines (or are malformed).
 *
 * Called from the `UsersService` constructor so any boot path that touches the
 * auth surface trips this **before** `server.listen()` binds. Exported so a
 * caller (e.g. `apps/server/src/index.ts`) can also call it explicitly even
 * earlier in startup if desired.
 */
export function assertArgon2ParamsMeetOwasp(): void {
  assertParamsMeetOwasp(readArgon2Params());
}

/**
 * Returns the current mint params, sourced from env with safe defaults.
 * Throws if the operator chose params below BOTH OWASP baselines.
 *
 * Note: this is also called by `UsersService` at construction time, so the
 * boot guard fires before any HTTP listener binds — it is not deferred to
 * the first mint.
 */
export function getArgon2Options(): {
  type: typeof argon2.argon2id;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
} {
  const params = readArgon2Params();
  assertParamsMeetOwasp(params);
  return { type: argon2.argon2id, ...params };
}

/**
 * Parse an argon2 encoded hash and assert it meets the configured mint
 * policy (which itself must satisfy at least one OWASP baseline). The hash
 * prefix shape is `$argon2id$v=19$m=<m>,t=<t>,p=<p>$salt$hash`.
 *
 * Reads the same env vars as `getArgon2Options` so mint and verify agree.
 */
export function hashMatchesPolicy(hash: string): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!m) return false;
  const memoryCost = Number(m[1]);
  const timeCost = Number(m[2]);
  const parallelism = Number(m[3]);
  if (!Number.isFinite(memoryCost) || !Number.isFinite(timeCost) || !Number.isFinite(parallelism)) return false;
  const policy = readArgon2Params();
  return (
    memoryCost >= policy.memoryCost &&
    timeCost >= policy.timeCost &&
    parallelism >= policy.parallelism
  );
}

// --- Zod schemas for hardened DB row decoding ------------------------------

const UserRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['member', 'admin']),
  created_at: z.number().int(),
  disabled_at: z.number().int().nullable(),
});

const TokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  hash: z.string(),
  label: z.string().nullable(),
  scopes: z.string(),
  namespace: z.string().nullable(),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
  expires_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
});

const NamespaceRowSchema = z.object({
  user_id: z.string(),
  namespace: z.string(),
  role: z.enum(['member', 'admin']),
});

const InviteRowSchema = z.object({
  jti: z.string(),
  namespace: z.string(),
  role: z.enum(['member', 'admin']),
  scopes: z.string(),
  expires_at: z.number().int(),
  consumed_at: z.number().int().nullable(),
  signature: z.string(),
  created_at: z.number().int(),
});

const SessionRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  namespace: z.string().nullable(),
  expires_at: z.number().int(),
  csrf_token: z.string(),
  created_at: z.number().int(),
});

// --- Public types ----------------------------------------------------------

export type Role = 'member' | 'admin';
export type Scope = 'hook:read' | 'read' | 'write' | 'admin';

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: number;
  disabledAt: number | null;
}

export interface TokenRecord {
  id: string;
  userId: string;
  label: string | null;
  scopes: Scope[];
  namespace: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface NamespaceMembership {
  userId: string;
  namespace: string;
  role: Role;
}

export interface InviteRecord {
  jti: string;
  namespace: string;
  role: Role;
  scopes: Scope[];
  expiresAt: number;
  consumedAt: number | null;
  signature: string;
  createdAt: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  namespace: string | null;
  expiresAt: number;
  csrfToken: string;
  createdAt: number;
}

// --- Helpers ---------------------------------------------------------------

function isScope(value: string): value is Scope {
  return value === 'hook:read' || value === 'read' || value === 'write' || value === 'admin';
}

function parseScopes(raw: string): Scope[] {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: Scope[] = [];
  for (const p of parts) {
    if (isScope(p)) {
      out.push(p);
    }
  }
  return out;
}

function serializeScopes(scopes: readonly Scope[]): string {
  return scopes.join(',');
}

/**
 * Base62 alphabet (`0-9A-Za-z`). Used for both the 32-char PAT secret and
 * the 6-char CRC32 suffix so the whole token is URL-safe and visually
 * distinct from base32 PATs of the previous format.
 */
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE62 = BigInt(BASE62_ALPHABET.length);

/** Encode an unsigned BigInt to base62, left-padded (or truncated) to `len`. */
function bigIntToBase62(value: bigint, len: number): string {
  if (value < 0n) throw new Error('bigIntToBase62: negative input');
  let n = value;
  let out = '';
  if (n === 0n) {
    out = '0';
  } else {
    while (n > 0n) {
      const idx = Number(n % BASE62);
      out = BASE62_ALPHABET[idx] + out;
      n = n / BASE62;
    }
  }
  if (out.length > len) return out.slice(out.length - len); // keep low-order chars
  return out.padStart(len, '0');
}

/**
 * Generate a 32-character base62 secret. We sample 32 base62 indices via
 * rejection sampling on `randomBytes` so each character is uniform across
 * the 62-symbol alphabet (no modulo bias).
 */
function generateBase62Secret(len: number): string {
  // 256 / 62 = 4.13, so values >= 248 are rejected to avoid bias
  // (248 = floor(256 / 62) * 62).
  const REJECTION_THRESHOLD = 248;
  let out = '';
  while (out.length < len) {
    const buf = randomBytes(len * 2); // overprovision; rejection rate is ~3%
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b >= REJECTION_THRESHOLD) continue;
      out += BASE62_ALPHABET[b % 62];
    }
  }
  return out;
}

/**
 * Compute the 6-character base62 CRC32 suffix for a PAT secret string.
 * `node:zlib`'s `crc32` returns a 32-bit unsigned integer; we encode it as
 * base62 padded/truncated to exactly 6 chars (62^6 ≈ 5.7e10, plenty of
 * room for a 32-bit value).
 */
function computePatChecksum(secret: string): string {
  const code = crc32(Buffer.from(secret, 'utf8'));
  return bigIntToBase62(BigInt(code >>> 0), 6);
}

const TOKEN_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generateTokenId(): string {
  const buf = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += TOKEN_ID_ALPHABET[buf[i] % TOKEN_ID_ALPHABET.length];
  }
  return out;
}

/**
 * PAT regex — see the file header comment for the format and the security
 * framing of the CRC32 suffix (defense-in-depth, not the auth gate).
 *
 * Single format only — no dual-format grace window. The project has
 * never run in production; old fixtures are regenerated.
 */
const PAT_REGEX = /^sbp_([a-z0-9]{8})_([A-Za-z0-9]{32})_([A-Za-z0-9]{6})$/;

export interface ParsedPat {
  tokenId: string;
  secret: string;
  checksum: string;
}

/**
 * Parse a PAT and validate the CRC32 suffix matches the secret. A mismatch
 * (or any structural failure) returns `null` so callers see a single
 * "invalid-token-format" outcome before the slow argon2id verify runs.
 */
export function parsePat(token: string): ParsedPat | null {
  const m = PAT_REGEX.exec(token);
  if (!m) return null;
  const tokenId = m[1];
  const secret = m[2];
  const checksum = m[3];
  if (!tokenId || !secret || !checksum) return null;
  if (computePatChecksum(secret) !== checksum) return null;
  return { tokenId, secret, checksum };
}

// --- Service ---------------------------------------------------------------

export interface UsersServiceOptions {
  /** SQLite file path; ':memory:' for tests. */
  path: string;
  /** Override clock for tests. */
  now?: () => number;
}

export class UsersService {
  readonly db: Database.Database;
  private readonly nowFn: () => number;

  constructor(opts: UsersServiceOptions) {
    // Refuse-boot guard: validate `BRAIN_ARGON2_*` env BEFORE we open the DB
    // or accept connections. Server boot constructs `UsersService` (see
    // `apps/server/src/index.ts`) before `server.listen()` binds, so a bad
    // env config fails fast at startup rather than on the first PAT mint.
    assertArgon2ParamsMeetOwasp();
    this.db = new Database(opts.path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.nowFn = opts.now ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  // --- Users ---

  createUser(input: { id: string; email: string; role: Role }): User {
    const now = this.nowFn();
    this.db
      .prepare(
        `INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.id, input.email, input.role, now);
    return { id: input.id, email: input.email, role: input.role, createdAt: now, disabledAt: null };
  }

  findUserByEmail(email: string): User | null {
    const row = this.db
      .prepare(`SELECT id, email, role, created_at, disabled_at FROM users WHERE email = ?`)
      .get(email);
    if (!row) return null;
    const parsed = UserRowSchema.parse(row);
    return {
      id: parsed.id,
      email: parsed.email,
      role: parsed.role,
      createdAt: parsed.created_at,
      disabledAt: parsed.disabled_at,
    };
  }

  findUserById(id: string): User | null {
    const row = this.db
      .prepare(`SELECT id, email, role, created_at, disabled_at FROM users WHERE id = ?`)
      .get(id);
    if (!row) return null;
    const parsed = UserRowSchema.parse(row);
    return {
      id: parsed.id,
      email: parsed.email,
      role: parsed.role,
      createdAt: parsed.created_at,
      disabledAt: parsed.disabled_at,
    };
  }

  /** Idempotent — returns the existing user if email already in use. */
  upsertUser(input: { email: string; role: Role }): User {
    const existing = this.findUserByEmail(input.email);
    if (existing) return existing;
    const id = generateUserId();
    return this.createUser({ id, email: input.email, role: input.role });
  }

  // --- Namespace memberships ---

  addNamespaceMembership(membership: NamespaceMembership): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO user_namespaces (user_id, namespace, role) VALUES (?, ?, ?)`,
      )
      .run(membership.userId, membership.namespace, membership.role);
  }

  listNamespaces(userId: string): NamespaceMembership[] {
    const rows = this.db
      .prepare(`SELECT user_id, namespace, role FROM user_namespaces WHERE user_id = ?`)
      .all(userId);
    return rows.map((r) => {
      const parsed = NamespaceRowSchema.parse(r);
      return { userId: parsed.user_id, namespace: parsed.namespace, role: parsed.role };
    });
  }

  hasNamespaceMembership(userId: string, namespace: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM user_namespaces WHERE user_id = ? AND namespace = ?`)
      .get(userId, namespace);
    return row !== undefined;
  }

  // --- Tokens (PATs) ---

  /**
   * Mints a PAT, hashes the secret, and inserts a row.
   * Returns the **plaintext** PAT — call site MUST hand it back to the user
   * exactly once and never persist it server-side.
   */
  async mintPat(input: {
    userId: string;
    label?: string | null;
    scopes: readonly Scope[];
    namespace?: string | null;
    expiresAt?: number | null;
  }): Promise<{ pat: string; tokenId: string; record: TokenRecord }> {
    const tokenId = generateTokenId();
    const secret = generateBase62Secret(32);
    const checksum = computePatChecksum(secret);
    const hash = await argon2.hash(secret, getArgon2Options());
    const now = this.nowFn();
    this.db
      .prepare(
        `INSERT INTO tokens (id, user_id, hash, label, scopes, namespace, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tokenId,
        input.userId,
        hash,
        input.label ?? null,
        serializeScopes(input.scopes),
        input.namespace ?? null,
        now,
        input.expiresAt ?? null,
      );
    const record: TokenRecord = {
      id: tokenId,
      userId: input.userId,
      label: input.label ?? null,
      scopes: [...input.scopes],
      namespace: input.namespace ?? null,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
    return { pat: `sbp_${tokenId}_${secret}_${checksum}`, tokenId, record };
  }

  getTokenById(tokenId: string): { record: TokenRecord; hash: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, hash, label, scopes, namespace, created_at, last_used_at, expires_at, revoked_at
         FROM tokens WHERE id = ?`,
      )
      .get(tokenId);
    if (!row) return null;
    const parsed = TokenRowSchema.parse(row);
    const record: TokenRecord = {
      id: parsed.id,
      userId: parsed.user_id,
      label: parsed.label,
      scopes: parseScopes(parsed.scopes),
      namespace: parsed.namespace,
      createdAt: parsed.created_at,
      lastUsedAt: parsed.last_used_at,
      expiresAt: parsed.expires_at,
      revokedAt: parsed.revoked_at,
    };
    return { record, hash: parsed.hash };
  }

  listTokens(userId: string): TokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, hash, label, scopes, namespace, created_at, last_used_at, expires_at, revoked_at
         FROM tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId);
    return rows.map((r) => {
      const parsed = TokenRowSchema.parse(r);
      return {
        id: parsed.id,
        userId: parsed.user_id,
        label: parsed.label,
        scopes: parseScopes(parsed.scopes),
        namespace: parsed.namespace,
        createdAt: parsed.created_at,
        lastUsedAt: parsed.last_used_at,
        expiresAt: parsed.expires_at,
        revokedAt: parsed.revoked_at,
      };
    });
  }

  revokeToken(tokenId: string): boolean {
    const result = this.db
      .prepare(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(this.nowFn(), tokenId);
    return Number(result.changes) > 0;
  }

  noteTokenUsed(tokenId: string): void {
    this.db.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).run(this.nowFn(), tokenId);
  }

  /**
   * Verifies a PAT presented by the client. Returns the matching token record
   * + the underlying user, or null when the token is invalid / revoked /
   * expired / unknown. Performs a constant-time argon2 verify.
   */
  async verifyPat(token: string): Promise<{ record: TokenRecord; user: User } | null> {
    const parsed = parsePat(token);
    if (!parsed) return null;
    const found = this.getTokenById(parsed.tokenId);
    if (!found) return null;
    const { record, hash } = found;
    if (record.revokedAt !== null) return null;
    if (record.expiresAt !== null && record.expiresAt <= this.nowFn()) return null;

    // Enforce the argon2id policy at verify time. The argon2 npm library's
    // verify(digest, password, options?) signature only accepts a `secret`
    // pepper — algorithm + cost params come from the encoded hash header. We
    // therefore parse the hash prefix and reject anything weaker than the
    // mint policy (or non-argon2id) before we even attempt verification.
    if (!hashMatchesPolicy(hash)) return null;
    let ok: boolean;
    try {
      ok = await argon2.verify(hash, parsed.secret);
    } catch {
      return null;
    }
    if (!ok) return null;

    const user = this.findUserById(record.userId);
    if (!user) return null;
    if (user.disabledAt !== null) return null;
    return { record, user };
  }

  // --- Invites ---

  insertInvite(invite: InviteRecord): void {
    this.db
      .prepare(
        `INSERT INTO invites (jti, namespace, role, scopes, expires_at, consumed_at, signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invite.jti,
        invite.namespace,
        invite.role,
        serializeScopes(invite.scopes),
        invite.expiresAt,
        invite.consumedAt,
        invite.signature,
        invite.createdAt,
      );
  }

  getInvite(jti: string): InviteRecord | null {
    const row = this.db
      .prepare(
        `SELECT jti, namespace, role, scopes, expires_at, consumed_at, signature, created_at
         FROM invites WHERE jti = ?`,
      )
      .get(jti);
    if (!row) return null;
    const parsed = InviteRowSchema.parse(row);
    return {
      jti: parsed.jti,
      namespace: parsed.namespace,
      role: parsed.role,
      scopes: parseScopes(parsed.scopes),
      expiresAt: parsed.expires_at,
      consumedAt: parsed.consumed_at,
      signature: parsed.signature,
      createdAt: parsed.created_at,
    };
  }

  /**
   * Atomic single-use redemption: returns true exactly once for a given jti.
   * Concurrent redeem attempts only succeed once because of the
   * `WHERE consumed_at IS NULL` clause.
   */
  consumeInvite(jti: string): boolean {
    const result = this.db
      .prepare(`UPDATE invites SET consumed_at = ? WHERE jti = ? AND consumed_at IS NULL`)
      .run(this.nowFn(), jti);
    return Number(result.changes) === 1;
  }

  // --- Sessions ---

  createSession(input: {
    userId: string;
    namespace: string | null;
    expiresAt: number;
  }): SessionRecord {
    const id = randomBytes(24).toString('hex');
    const csrfToken = randomBytes(24).toString('hex');
    const now = this.nowFn();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, namespace, expires_at, csrf_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, input.namespace, input.expiresAt, csrfToken, now);
    return {
      id,
      userId: input.userId,
      namespace: input.namespace,
      expiresAt: input.expiresAt,
      csrfToken,
      createdAt: now,
    };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, namespace, expires_at, csrf_token, created_at FROM sessions WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    const parsed = SessionRowSchema.parse(row);
    return {
      id: parsed.id,
      userId: parsed.user_id,
      namespace: parsed.namespace,
      expiresAt: parsed.expires_at,
      csrfToken: parsed.csrf_token,
      createdAt: parsed.created_at,
    };
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
}

export function generateUserId(): string {
  return 'usr_' + randomBytes(8).toString('hex');
}
