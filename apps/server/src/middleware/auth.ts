/**
 * Auth middleware — accepts:
 *   1. `Authorization: Bearer sbp_<id>_<secret>`  (CLI / hooks / programmatic)
 *   2. `Cookie: sb_session=<id>` + `X-CSRF-Token: <csrf>`  (UI)
 *   3. `Authorization: Bearer <legacy>` matching `BRAIN_AUTH_TOKEN` env
 *      (solo back-compat)
 *
 * Resolves the request's effective namespace per plan §F:
 *   - locked-namespace tokens (`tokens.namespace IS NOT NULL`) → that namespace
 *   - NULL-namespace tokens   → any of the user's `user_namespaces`
 *   - sessions                → `sessions.namespace`
 *
 * BRAIN_AUTH_MODE governs strictness:
 *   - 'open' (default) → permissive when no auth provided (matches today)
 *   - 'pat'            → 401 unless one of the schemes above succeeds
 */
import type { Request, Response, NextFunction } from 'express';
import type { UsersService, Role, Scope, TokenRecord, User } from '../services/users.js';

export type AuthMode = 'open' | 'pat';

export interface AuthedUser {
  id: string;
  email: string;
  role: Role;
  /** Resolved namespace for THIS request — body/query/params override token default. */
  namespace: string | null;
  /**
   * The token's locked namespace, separate from the resolved namespace above.
   * `null` for unbound tokens (the user's `user_namespaces` rows then govern
   * which namespaces the request may target).
   */
  tokenNamespace: string | null;
  scopes: Scope[];
  authMode: 'pat' | 'session' | 'legacy';
  tokenId: string | null;
  sessionId: string | null;
}

/**
 * Augment the Express Request globally with `user?: AuthedUser`. This keeps
 * callback parameter typing intact (path params remain `string`) so route
 * handlers don't need an explicit `RequestWithUser` annotation that would
 * otherwise widen `req.params` and `req.query`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/** Alias kept for back-compat callers that already use `RequestWithUser`. */
export type RequestWithUser = Request;

export interface AuthMiddlewareOptions {
  /** Auth mode — 'open' is permissive, 'pat' rejects unauth'd /api/* requests. */
  mode: AuthMode;
  /** UsersService instance (required when mode='pat' or when minted PATs are used). */
  users?: UsersService | null;
  /** Legacy bearer token for solo back-compat. */
  legacyBearerToken?: string | null;
  /** Paths (under /api/*) to skip auth on. */
  skipPaths?: string[];
  /** Override clock for tests. */
  now?: () => number;
}

const DEFAULT_SKIP_PATHS = [
  '/api/auth/redeem-invite',
  '/api/auth/login',
];

const SESSION_COOKIE_NAME = 'sb_session';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.split('=');
    if (!k) continue;
    const key = k.trim();
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

function extractBearer(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization);
  return m ? m[1].trim() : null;
}

function isWriteMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function isSkipped(path: string, skip: string[]): boolean {
  return skip.some((p) => path === p || path.startsWith(p + '/'));
}

function tokenScopesAllowNamespace(
  record: TokenRecord,
  requested: string,
  users: UsersService,
): boolean {
  if (record.namespace !== null) return record.namespace === requested;
  return users.hasNamespaceMembership(record.userId, requested);
}

function buildAuthedUserFromToken(
  record: TokenRecord,
  user: User,
  resolvedNamespace: string | null,
): AuthedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    namespace: resolvedNamespace,
    tokenNamespace: record.namespace,
    scopes: record.scopes,
    authMode: 'pat',
    tokenId: record.id,
    sessionId: null,
  };
}

function readStringField(value: unknown, key: string): string | null {
  if (value !== null && typeof value === 'object' && key in value) {
    const v = Reflect.get(value, key);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Collect every namespace surface a request might target. The middleware
 * must validate the token against ALL of them — otherwise a request like
 * `{ namespace: 'alpha', project: 'beta' }` would slip past a token bound
 * to alpha because only the first hit was checked.
 *
 * Sources:
 *   - `body.namespace`   — explicit field on most observe / entity / relation payloads
 *   - `body.project`     — observe `session-start` uses `project` as the namespace surface
 *   - `query.namespace`  — read routes carry it as a query parameter
 *
 * Order does not matter for security — every value is validated. We return
 * a deduplicated set so callers don't double-check the common case where
 * the same value appears in multiple slots.
 */
function collectRequestedNamespaces(req: Request): string[] {
  const out = new Set<string>();
  const slots: Array<string | null> = [
    readStringField(req.body, 'namespace'),
    readStringField(req.body, 'project'),
    readStringField(req.query, 'namespace'),
  ];
  for (const v of slots) {
    if (v) out.add(v);
  }
  return [...out];
}

/** Returns the first namespace (priority body.namespace → body.project → query) or null. */
function pickRequestedNamespace(req: Request): string | null {
  const all = collectRequestedNamespaces(req);
  return all.length > 0 ? all[0] : null;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const skipPaths = [...DEFAULT_SKIP_PATHS, ...(options.skipPaths ?? [])];
  const now = options.now ?? Date.now;

  return async function authMiddleware(
    req: RequestWithUser,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.path.startsWith('/api/')) return next();
    if (isSkipped(req.path, skipPaths)) return next();

    const bearer = extractBearer(req.headers.authorization);
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE_NAME];

    // 1) PAT
    if (bearer && bearer.startsWith('sbp_') && options.users) {
      try {
        const verified = await options.users.verifyPat(bearer);
        if (!verified) {
          res.status(401).json({ error: 'invalid-token' });
          return;
        }
        // Validate the token against EVERY namespace surface in the request,
        // not just the first one — body can carry both `namespace` and
        // `project` and we must reject mismatches in either.
        const allRequested = collectRequestedNamespaces(req);
        for (const r of allRequested) {
          if (!tokenScopesAllowNamespace(verified.record, r, options.users)) {
            res.status(403).json({ error: 'namespace-mismatch' });
            return;
          }
        }
        const ns = verified.record.namespace ?? allRequested[0] ?? null;
        options.users.noteTokenUsed(verified.record.id);
        req.user = buildAuthedUserFromToken(verified.record, verified.user, ns);
        return next();
      } catch (err) {
        return next(err);
      }
    }

    // 2) Legacy bearer
    if (bearer && options.legacyBearerToken && bearer === options.legacyBearerToken) {
      req.user = {
        id: 'legacy',
        email: 'legacy@second-brain.local',
        role: 'admin',
        namespace: pickRequestedNamespace(req),
        tokenNamespace: null,
        scopes: ['admin'],
        authMode: 'legacy',
        tokenId: null,
        sessionId: null,
      };
      return next();
    }

    // 3) Session cookie
    if (sessionId && options.users) {
      try {
        const session = options.users.getSession(sessionId);
        if (!session) {
          if (options.mode === 'pat') {
            res.status(401).json({ error: 'invalid-session' });
            return;
          }
          return next();
        }
        if (session.expiresAt <= now()) {
          options.users.deleteSession(session.id);
          res.status(401).json({ error: 'session-expired' });
          return;
        }
        // CSRF — PATs bypass; sessions require X-CSRF-Token on writes.
        if (isWriteMethod(req.method)) {
          const csrf = req.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || csrf !== session.csrfToken) {
            res.status(403).json({ error: 'csrf-required' });
            return;
          }
        }
        const allRequested = collectRequestedNamespaces(req);
        for (const requested of allRequested) {
          if (session.namespace !== null && session.namespace !== requested) {
            if (!options.users.hasNamespaceMembership(session.userId, requested)) {
              res.status(403).json({ error: 'namespace-mismatch' });
              return;
            }
          }
        }
        const user = options.users.findUserById(session.userId);
        if (!user) {
          res.status(401).json({ error: 'unknown-user' });
          return;
        }
        req.user = {
          id: user.id,
          email: user.email,
          role: user.role,
          namespace: session.namespace ?? allRequested[0] ?? null,
          tokenNamespace: null,
          scopes: ['read', 'write'],
          authMode: 'session',
          tokenId: null,
          sessionId: session.id,
        };
        return next();
      } catch (err) {
        return next(err);
      }
    }

    // 4) No auth provided
    if (options.mode === 'pat') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    return next();
  };
}

export function requireScope(...required: Scope[]) {
  return function scopeGuard(req: Request, res: Response, next: NextFunction): void {
    // Open mode (no auth middleware mounted, or middleware permitted no-user
    // request through): treat as permissive — we never enforce scopes when
    // there's no identity to compare against. This matches `enforceNamespace`.
    if (!req.user) return next();
    if (req.user.authMode === 'legacy') return next();
    const has = req.user.scopes;
    for (const r of required) {
      if (has.includes(r)) return next();
    }
    res.status(403).json({ error: 'insufficient-scope' });
  };
}

/**
 * Admin guard — when an identity exists, require it to be admin or legacy.
 *
 * Open-mode passthrough (`if (!req.user) return next()`) is safe because:
 *   - In pat mode the global auth middleware already 401'd on /api/* before
 *     this guard runs, so a missing `req.user` here means open mode.
 *   - In open mode the operator has explicitly chosen "no auth" — admin
 *     endpoints are reachable, matching pre-PR1 behavior. Operators who
 *     want pat-style guarding should switch to `BRAIN_AUTH_MODE='pat'`
 *     (or set `BRAIN_AUTH_TOKEN` for legacy bearer protection).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return next();
  if (req.user.role === 'admin' || req.user.authMode === 'legacy') return next();
  res.status(403).json({ error: 'admin-required' });
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;

/**
 * Resolve the namespace that a *query* (search / stats / temporal / parallel
 * work) should run against. Unlike `enforceNamespace`, this runs BEFORE the
 * core call rather than after a resource load — for read routes that scan
 * multiple rows we have no resource to inspect.
 *
 * Rules:
 *   - No `req.user`         → open mode, return `requested` unchanged.
 *   - `authMode === 'legacy'` → return `requested` unchanged (solo bypass).
 *   - Token locked (`tokenNamespace !== null`):
 *       · `requested` matches or omitted → return `tokenNamespace` (forced).
 *       · `requested` differs            → 403, return null.
 *   - Unbound token / session (`tokenNamespace === null`):
 *       · `requested` set → check membership; reject mismatch with 403.
 *       · `requested` omitted → 400 "namespace-required". Without an
 *         explicit namespace, returning `undefined` would let the core scan
 *         every namespace in storage (verified — core APIs treat
 *         `namespace=undefined` as "no constraint"). Requiring the caller
 *         to be explicit closes that hole. If you genuinely need to query
 *         across namespaces, mint multiple namespace-locked tokens or use
 *         the legacy bearer / open mode.
 *
 * The return value is `string | undefined | null`:
 *   - `string`     → use this namespace
 *   - `undefined`  → no constraint to apply (open / legacy)
 *   - `null`       → response already sent (403 or 400); caller must `return`.
 */
export function resolveScopedNamespace(
  req: Request,
  res: Response,
  requested: string | undefined,
  users: UsersService | null | undefined,
): string | undefined | null {
  const u = req.user;
  if (!u) return requested;
  if (u.authMode === 'legacy') return requested;

  if (u.tokenNamespace !== null) {
    if (requested && requested !== u.tokenNamespace) {
      res.status(403).json({ error: 'namespace-mismatch' });
      return null;
    }
    return u.tokenNamespace;
  }

  // Unbound token / session
  if (requested) {
    if (!users) return requested;
    if (!users.hasNamespaceMembership(u.id, requested)) {
      res.status(403).json({ error: 'namespace-mismatch' });
      return null;
    }
    return requested;
  }
  res.status(400).json({ error: 'namespace-required' });
  return null;
}

/**
 * Per-route namespace authorization. Call this AFTER loading a resource
 * (entity/relation/sync-room) to assert the request's token/session is
 * allowed to act on `namespace`. On deny, sends 403 and returns false; on
 * allow, returns true and the route continues.
 *
 * Permissive cases (return true without checking):
 *   - No `req.user`         — open mode, no auth required
 *   - `authMode === 'legacy'`— solo / CI master token bypasses scoping
 *
 * Strict cases:
 *   - PAT with locked `tokenNamespace` → must equal `namespace`
 *   - Otherwise (unbound PAT or session) → must have `user_namespaces` row
 *     for `namespace` (or `users` is null in tests where membership is
 *     pre-loaded into req.user; we fall back to `req.user.namespace`).
 */
export function enforceNamespace(
  req: RequestWithUser,
  res: Response,
  namespace: string,
  users: UsersService | null | undefined,
): boolean {
  const u = req.user;
  if (!u) return true;
  if (u.authMode === 'legacy') return true;

  if (u.tokenNamespace !== null) {
    if (u.tokenNamespace === namespace) return true;
    res.status(403).json({ error: 'namespace-mismatch' });
    return false;
  }

  if (users) {
    if (users.hasNamespaceMembership(u.id, namespace)) return true;
    res.status(403).json({ error: 'namespace-mismatch' });
    return false;
  }

  // No users service available — fall back to comparing the resolved namespace.
  if (u.namespace === null || u.namespace === namespace) return true;
  res.status(403).json({ error: 'namespace-mismatch' });
  return false;
}
