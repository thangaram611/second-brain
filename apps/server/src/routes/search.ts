import { Router } from 'express';
import type { Brain } from '@second-brain/core';
import type { EntityType } from '@second-brain/types';
import { SearchQuerySchema } from '../schemas.js';

export function searchRoutes(brain: Brain): Router {
  const router = Router();

  // Unified search
  router.get('/api/search', (req, res) => {
    const params = SearchQuerySchema.parse(req.query);

    const types = params.types
      ? (params.types.split(',') as EntityType[])
      : undefined;

    const results = brain.search.search({
      query: params.q,
      namespace: params.namespace,
      types,
      limit: params.limit,
      offset: params.offset,
      minConfidence: params.minConfidence,
    });

    res.json(results);
  });

  // Graph stats
  router.get('/api/stats', (req, res) => {
    const namespace =
      typeof req.query.namespace === 'string' ? req.query.namespace : undefined;
    const stats = brain.search.getStats(namespace);
    res.json(stats);
  });

  return router;
}
