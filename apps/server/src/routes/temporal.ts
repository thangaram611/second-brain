import { Router } from 'express';
import type { Brain } from '@second-brain/core';
import type { EntityType } from '@second-brain/types';
import {
  TimelineQuerySchema,
  ContradictionsQuerySchema,
  ResolveContradictionSchema,
  StaleQuerySchema,
  DecisionLogQuerySchema,
  TemporalEntityQuerySchema,
} from '../schemas.js';
import { broadcast } from '../ws/ws-server.js';
import { requireRelation, paramString } from './helpers.js';
import {
  enforceNamespace,
  requireScope,
  resolveScopedNamespace,
} from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';

export interface TemporalRoutesOptions {
  users?: UsersService | null;
}

export function temporalRoutes(
  brain: Brain,
  options: TemporalRoutesOptions = {},
): Router {
  const router = Router();
  const users = options.users ?? null;

  // --- Timeline ---
  router.get('/api/timeline', (req, res) => {
    const params = TimelineQuerySchema.parse(req.query);
    const ns = resolveScopedNamespace(req, res, params.namespace, users);
    if (ns === null) return;
    const types = params.types
      ? (params.types.split(',').filter(Boolean) as EntityType[])
      : undefined;

    const entries = brain.temporal.getTimeline({
      from: params.from,
      to: params.to,
      namespace: ns,
      types,
      limit: params.limit,
      offset: params.offset,
    });

    res.json(entries);
  });

  // --- Contradictions ---
  router.get('/api/contradictions', (req, res) => {
    const params = ContradictionsQuerySchema.parse(req.query);
    const ns = resolveScopedNamespace(req, res, params.namespace, users);
    if (ns === null) return;
    const contradictions = brain.contradictions.getUnresolved(ns);
    res.json(contradictions);
  });

  router.post(
    '/api/contradictions/:id/resolve',
    requireScope('write', 'admin'),
    (req, res) => {
      const { winnerId } = ResolveContradictionSchema.parse(req.body);
      const relationId = paramString(req.params.id);

      const relation = requireRelation(brain, relationId, res);
      if (!relation) return;
      if (!enforceNamespace(req, res, relation.namespace, users)) return;

      const loserId = relation.sourceId === winnerId ? relation.targetId : relation.sourceId;

      brain.contradictions.resolve(relationId, winnerId);

      broadcast({ type: 'contradiction:resolved', relationId, winnerId, loserId });
      res.json({ resolved: true, winnerId, loserId });
    },
  );

  router.delete(
    '/api/contradictions/:id',
    requireScope('write', 'admin'),
    (req, res) => {
      const relationId = paramString(req.params.id);
      const relation = requireRelation(brain, relationId, res);
      if (!relation) return;
      if (!enforceNamespace(req, res, relation.namespace, users)) return;

      brain.contradictions.dismiss(relationId);

      broadcast({ type: 'contradiction:dismissed', relationId });
      res.status(204).end();
    },
  );

  // --- Stale entities ---
  router.get('/api/stale', (req, res) => {
    const params = StaleQuerySchema.parse(req.query);
    const ns = resolveScopedNamespace(req, res, params.namespace, users);
    if (ns === null) return;
    const types = params.types
      ? (params.types.split(',').filter(Boolean) as EntityType[])
      : undefined;

    const stale = brain.decay.getStaleEntities({
      threshold: params.threshold,
      namespace: ns,
      types,
      limit: params.limit,
      offset: params.offset,
    });

    res.json(stale);
  });

  // --- Decision log ---
  router.get('/api/decisions', (req, res) => {
    const params = DecisionLogQuerySchema.parse(req.query);
    const ns = resolveScopedNamespace(req, res, params.namespace, users);
    if (ns === null) return;

    let decisions = brain.entities.findByType('decision', ns);

    // Sort
    const sort = params.sort ?? 'newest';
    if (sort === 'newest') {
      decisions.sort((a, b) => new Date(b.eventTime).getTime() - new Date(a.eventTime).getTime());
    } else if (sort === 'oldest') {
      decisions.sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
    } else if (sort === 'confidence') {
      decisions.sort((a, b) => b.confidence - a.confidence);
    }

    // Paginate
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    decisions = decisions.slice(offset, offset + limit);

    res.json(decisions);
  });

  // --- Bitemporal as-of query ---
  router.get('/api/temporal/entities', (req, res) => {
    const params = TemporalEntityQuerySchema.parse(req.query);
    const ns = resolveScopedNamespace(req, res, params.namespace, users);
    if (ns === null) return;
    const types = params.types
      ? (params.types.split(',').filter(Boolean) as EntityType[])
      : undefined;

    const entities = brain.temporal.getEntitiesAsOf({
      asOfEventTime: params.asOfEventTime,
      asOfIngestTime: params.asOfIngestTime,
      namespace: ns,
      types,
      limit: params.limit,
      offset: params.offset,
    });

    res.json(entities);
  });

  return router;
}
