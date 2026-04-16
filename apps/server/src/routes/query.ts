import { Router } from 'express';
import { z } from 'zod';
import type { OwnershipService } from '../services/ownership-service.js';

export interface QueryRouteOptions {
  bearerToken?: string;
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
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });

  router.get('/api/query/ownership', async (req, res, next) => {
    try {
      const query = OwnershipQuerySchema.parse(req.query);
      const results = await ownership.query({
        path: query.path,
        limit: query.limit,
      });
      res.json(results);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
