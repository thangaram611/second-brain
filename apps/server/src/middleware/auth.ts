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
  namespace: string | null;
  scopes: Scope[];
  authMode: 'pat' | 'session' | 'legacy';
  tokenId: string | null;
  sessionId: string | null;
}

/** Extended Express Request with attached auth state. */
export interface RequestWithUser extends Request {
  user?: AuthedUser;
}

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
    scopes: record.scopes,
    authMode: 'pat',
    tokenId: record.id,
    sessionId: null,
  };
}

function readNamespaceField(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && 'namespace' in value) {
    const ns = Reflect.get(value, 'namespace');
    if (typeof ns === 'string' && ns.length > 0) return ns;
  }
  return null;
}

function pickRequestedNamespace(req: Request): string | null {
  return readNamespaceField(req.body) ?? readNamespaceField(req.query);
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
        const requested = pickRequestedNamespace(req);
        if (requested && !tokenScopesAllowNamespace(verified.record, requested, options.users)) {
          res.status(403).json({ error: 'namespace-mismatch' });
          return;
        }
        const ns = verified.record.namespace ?? requested;
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
        const requested = pickRequestedNamespace(req);
        if (requested && session.namespace !== null && session.namespace !== requested) {
          if (!options.users.hasNamespaceMembership(session.userId, requested)) {
            res.status(403).json({ error: 'namespace-mismatch' });
            return;
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
          namespace: session.namespace ?? requested,
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
  return function scopeGuard(req: RequestWithUser, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (req.user.authMode === 'legacy') return next();
    const has = req.user.scopes;
    for (const r of required) {
      if (has.includes(r)) return next();
    }
    res.status(403).json({ error: 'insufficient-scope' });
  };
}

export function requireAdmin(req: RequestWithUser, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.user.role === 'admin' || req.user.authMode === 'legacy') return next();
  res.status(403).json({ error: 'admin-required' });
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
