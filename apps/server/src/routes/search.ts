import { Router } from 'express';
import type { Brain } from '@second-brain/core';
import type { EntityType } from '@second-brain/types';
import { SearchQuerySchema } from '../schemas.js';
import { resolveScopedNamespace } from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';

export interface SearchRoutesOptions {
  users?: UsersService | null;
}

export function searchRoutes(
  brain: Brain,
  options: SearchRoutesOptions = {},
): Router {
  const router = Router();
  const users = options.users ?? null;

  // Unified search
  router.get('/api/search', (req, res) => {
    const params = SearchQuerySchema.parse(req.query);
    const ns = resolveScopedNamespace(req, res, params.namespace, users);
    if (ns === null) return;

    const types = params.types
      ? (params.types.split(',') as EntityType[])
      : undefined;

    const results = brain.search.search({
      query: params.q,
      namespace: ns,
      types,
      limit: params.limit,
      offset: params.offset,
      minConfidence: params.minConfidence,
    });

    res.json(results);
  });

  // Graph stats
  router.get('/api/stats', (req, res) => {
    const requested =
      typeof req.query.namespace === 'string' ? req.query.namespace : undefined;
    const ns = resolveScopedNamespace(req, res, requested, users);
    if (ns === null) return;
    const stats = brain.search.getStats(ns);
    res.json(stats);
  });

  return router;
}
