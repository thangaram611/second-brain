/**
 * users.db sidecar — server-side identity, PATs, invites, and sessions.
 *
 * PAT format: `sbp_<8-char-id>_<32-byte-base32-secret>`
 *   - The id is the primary key in `tokens`. The secret is hashed with
 *     argon2id and stored as `tokens.hash`.
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

// --- Argon2id stretching params (per plan) ---------------------------------

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

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

const SCOPE_VALUES: readonly Scope[] = ['hook:read', 'read', 'write', 'admin'];

function isScope(value: string): value is Scope {
  return (SCOPE_VALUES as readonly string[]).includes(value);
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

/** Crockford-ish base32 (RFC 4648 alphabet without padding). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
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

const PAT_REGEX = /^sbp_([a-z0-9]{8})_([A-Z2-7]+)$/;

export interface ParsedPat {
  tokenId: string;
  secret: string;
}

export function parsePat(token: string): ParsedPat | null {
  const m = PAT_REGEX.exec(token);
  if (!m) return null;
  const tokenId = m[1];
  const secret = m[2];
  if (!tokenId || !secret) return null;
  return { tokenId, secret };
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
    const secret = base32encode(randomBytes(32));
    const hash = await argon2.hash(secret, ARGON2_OPTIONS);
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
    return { pat: `sbp_${tokenId}_${secret}`, tokenId, record };
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

    let ok = false;
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
