import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Brain } from '@second-brain/core';
import type { OwnershipService } from '../services/ownership-service.js';
import { resolveScopedNamespace } from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';

/**
 * Resolve the namespace for an ownership lookup. Wraps `resolveScopedNamespace`.
 * In open mode (no auth wired) there is no multi-tenancy, so an omitted
 * `?namespace=` falls back to `'personal'` — the same default the rest of the
 * API uses for an unauthenticated, single-user brain (and where solo
 * `brain index` writes). In auth mode the namespace is still derived/validated
 * from the token or session by `resolveScopedNamespace`. Returns:
 *   - `string` → the namespace to use
 *   - `null`   → response already sent (403); caller must `return`
 */
function resolveOwnershipNamespace(
  req: Request,
  res: Response,
  requested: string | undefined,
  users: UsersService | null | undefined,
): string | null {
  const ns = resolveScopedNamespace(req, res, requested, users ?? null);
  if (ns === null) return null;
  if (ns === undefined) {
    // Open mode — no auth gate. Use the requested namespace, else default to
    // the local single-user namespace.
    return requested ?? 'personal';
  }
  return ns;
}

export interface QueryRouteOptions {
  bearerToken?: string;
  brain?: Brain;
  users?: UsersService | null;
}

export function queryRoutes(ownership: OwnershipService, options: QueryRouteOptions = {}): Router {
  const router = Router();

  // Bearer auth (same pattern as observe.ts)
  if (options.bearerToken) {
    const expected = `Bearer ${options.bearerToken}`;
    router.use('/api/query', (req, res, next) => {
      if (req.headers.authorization !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
  }

  const OwnershipQuerySchema = z.object({
    path: z.string().min(1),
    namespace: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });

  router.get('/api/query/ownership', async (req, res, next) => {
    try {
      const query = OwnershipQuerySchema.parse(req.query);
      const namespace = resolveOwnershipNamespace(req, res, query.namespace, options.users);
      if (namespace === null) return; // response already sent
      const results = await ownership.query({
        path: query.path,
        limit: query.limit,
        namespace,
      });
      res.json(results);
    } catch (err) {
      next(err);
    }
  });

  // --- Ownership tree endpoint ---

  const OwnershipTreeQuerySchema = z.object({
    path: z.string().min(1).default('.'),
    namespace: z.string().min(1).optional(),
    depth: z.coerce.number().int().min(1).max(5).default(2),
    limit: z.coerce.number().int().min(1).max(50).default(3),
  });

  router.get('/api/query/ownership-tree', async (req, res, next) => {
    let requestedPath = '.';
    try {
      const query = OwnershipTreeQuerySchema.parse(req.query);
      requestedPath = query.path;
      const namespace = resolveOwnershipNamespace(req, res, query.namespace, options.users);
      if (namespace === null) return; // response already sent

      const tree = await ownership.queryTree({
        path: query.path,
        depth: query.depth,
        limit: query.limit,
        namespace,
      });
      res.json(tree);
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        res.status(404).json({ error: 'path-not-found', path: requestedPath });
        return;
      }
      next(err);
    }
  });

  // --- Parallel work endpoint ---

  const ParallelWorkQuerySchema = z.object({
    branch: z.string().optional(),
    namespace: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  router.get('/api/query/parallel-work', (req, res, next) => {
    try {
      if (!options.brain) {
        res.status(503).json({ error: 'brain-not-configured' });
        return;
      }
      const query = ParallelWorkQuerySchema.parse(req.query);
      const users = options.users ?? null;
      const ns = resolveScopedNamespace(req, res, query.namespace, users);
      if (ns === null) return;
      const rows = options.brain.findParallelWork({
        branch: query.branch ?? undefined,
        namespace: ns ?? undefined,
        limit: query.limit,
      });
      const conflicts = rows.map((row) => ({
        entityId: row.entityId,
        entityName: row.entityName,
        entityType: row.entityType,
        namespace: row.namespace,
        actors: row.actors,
        branches: row.branches,
      }));
      res.json({ conflicts });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
