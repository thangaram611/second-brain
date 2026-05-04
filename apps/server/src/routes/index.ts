import type { Express } from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import { entityRoutes } from './entities.js';
import { relationRoutes } from './relations.js';
import { searchRoutes } from './search.js';
import { syncRoutes } from './sync.js';
import { temporalRoutes } from './temporal.js';
import { adminRoutes } from './admin.js';
import { observeRoutes, type ObserveRouteOptions } from './observe.js';
import { queryRoutes, type QueryRouteOptions } from './query.js';
import { authRoutes } from './auth.js';
import { createAuthMiddleware, type AuthMode } from '../middleware/auth.js';
import { redactMiddleware } from '../middleware/redact.js';
import type { ObservationService } from '../services/observation-service.js';
import type { OwnershipService } from '../services/ownership-service.js';
import type { UsersService } from '../services/users.js';

export interface RegisterRoutesOptions {
  syncManager?: SyncManager;
  observations?: ObservationService;
  observeOptions?: ObserveRouteOptions;
  ownership?: OwnershipService;
  queryOptions?: QueryRouteOptions;
  /** Optional auth surface — when provided, mounts auth routes + middleware. */
  auth?: {
    mode: AuthMode;
    users: UsersService;
    inviteSigningKey: string | null;
    legacyBearerToken?: string | null;
    /** Override clock for tests. */
    now?: () => number;
    /** Set the Secure flag on session cookies (defaults to true). */
    secureCookies?: boolean;
  };
  /** Optional extra denylist patterns from team manifest. */
  redactPatterns?: readonly RegExp[];
}

export function registerRoutes(
  app: Express,
  brain: Brain,
  options: RegisterRoutesOptions = {},
): void {
  const { syncManager, observations, observeOptions } = options;

  // Mount redact middleware before any /api/observe handler so the body
  // is already cleaned by the time observation-service sees it.
  app.use(redactMiddleware({ extraPatterns: options.redactPatterns }));

  // The auth middleware MUST run before any route that reads `req.user`.
  // Its skip list includes /api/auth/redeem-invite and /api/auth/login so
  // those remain reachable without an existing identity. All other
  // /api/auth/* routes (whoami, logout, rotate) need an authenticated
  // request so they sit AFTER the middleware.
  if (options.auth) {
    app.use(
      createAuthMiddleware({
        mode: options.auth.mode,
        users: options.auth.users,
        legacyBearerToken: options.auth.legacyBearerToken ?? null,
        now: options.auth.now,
      }),
    );
    app.use(
      authRoutes({
        users: options.auth.users,
        inviteSigningKey: options.auth.inviteSigningKey,
        now: options.auth.now,
        secureCookies: options.auth.secureCookies,
        authMode: options.auth.mode,
      }),
    );
  }

  const usersForAuthz = options.auth?.users ?? null;
  app.use(entityRoutes(brain, syncManager, { users: usersForAuthz }));
  app.use(relationRoutes(brain, syncManager, { users: usersForAuthz }));
  app.use(searchRoutes(brain, { users: usersForAuthz }));
  app.use(temporalRoutes(brain, { users: usersForAuthz }));
  app.use(
    adminRoutes(brain, {
      users: options.auth?.users,
      inviteSigningKey: options.auth?.inviteSigningKey ?? null,
      now: options.auth?.now,
    }),
  );
  if (syncManager) {
    app.use(syncRoutes(syncManager, { users: usersForAuthz }));
  }
  if (observations) {
    app.use(observeRoutes(observations, observeOptions));
  }
  if (options.ownership) {
    app.use(
      queryRoutes(options.ownership, {
        ...options.queryOptions,
        brain,
        users: usersForAuthz,
      }),
    );
  }
}
