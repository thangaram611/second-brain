import { Router } from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import type { EntityType, RelationType } from '@second-brain/types';
import {
  CreateEntitySchema,
  UpdateEntitySchema,
  ObservationSchema,
  ListQuerySchema,
  NeighborsQuerySchema,
} from '../schemas.js';
import { broadcast } from '../ws/ws-server.js';
import { requireEntity, deleteEntityWithSync, paramString } from './helpers.js';
import { enforceNamespace, requireScope } from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';

export interface EntityRoutesOptions {
  /** Optional users service used by `enforceNamespace` to verify membership. */
  users?: UsersService | null;
}

export function entityRoutes(
  brain: Brain,
  syncManager?: SyncManager,
  options: EntityRoutesOptions = {},
): Router {
  const router = Router();
  const users = options.users ?? null;

  // List entities
  router.get('/api/entities', (req, res) => {
    const params = ListQuerySchema.parse(req.query);

    let results;
    if (params.type) {
      results = brain.entities.findByType(
        params.type as EntityType,
        params.namespace,
      );
      // Apply limit/offset manually for findByType
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 100;
      results = results.slice(offset, offset + limit);
    } else {
      results = brain.entities.list({
        namespace: params.namespace,
        limit: params.limit,
        offset: params.offset,
      });
    }

    // Sort by updatedAt descending (most recent first)
    results.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    res.json(results);
  });

  // Get entity by ID (with relations)
  router.get('/api/entities/:id', (req, res) => {
    const entity = requireEntity(brain, paramString(req.params.id), res);
    if (!entity) return;
    if (!enforceNamespace(req, res, entity.namespace, users)) return;

    brain.entities.touch(entity.id);
    const outbound = brain.relations.getOutbound(entity.id);
    const inbound = brain.relations.getInbound(entity.id);

    res.json({ entity, outbound, inbound });
  });

  // Create entity
  router.post('/api/entities', requireScope('write', 'admin'), (req, res) => {
    const input = CreateEntitySchema.parse(req.body);
    const targetNs = input.namespace ?? 'default';
    if (!enforceNamespace(req, res, targetNs, users)) return;
    const entity = brain.entities.create({
      type: input.type as EntityType,
      name: input.name,
      observations: input.observations ?? [],
      tags: input.tags ?? [],
      namespace: input.namespace,
      properties: input.properties,
      confidence: input.confidence,
      source: { type: 'manual' },
    });

    broadcast({ type: 'entity:created', entity });
    if (syncManager?.isSynced(entity.namespace)) {
      syncManager.onLocalEntityChange(entity);
    }
    res.status(201).json(entity);
  });

  // Update entity
  router.patch('/api/entities/:id', requireScope('write', 'admin'), (req, res) => {
    const patch = UpdateEntitySchema.parse(req.body);
    const existing = brain.entities.get(paramString(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (!enforceNamespace(req, res, existing.namespace, users)) return;
    const entity = brain.entities.update(paramString(req.params.id), patch);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    broadcast({ type: 'entity:updated', entity });
    if (syncManager?.isSynced(entity.namespace)) {
      syncManager.onLocalEntityChange(entity);
    }
    res.json(entity);
  });

  // Delete entity
  router.delete('/api/entities/:id', requireScope('write', 'admin'), (req, res) => {
    const existing = brain.entities.get(paramString(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (!enforceNamespace(req, res, existing.namespace, users)) return;
    const deleted = deleteEntityWithSync(paramString(req.params.id), brain, syncManager);
    if (!deleted) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    res.status(204).end();
  });

  // Add observation
  router.post('/api/entities/:id/observations', requireScope('write', 'admin'), (req, res) => {
    const { observation } = ObservationSchema.parse(req.body);
    const existing = brain.entities.get(paramString(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (!enforceNamespace(req, res, existing.namespace, users)) return;
    const entity = brain.entities.addObservation(paramString(req.params.id), observation);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    broadcast({ type: 'entity:updated', entity });
    if (syncManager?.isSynced(entity.namespace)) {
      syncManager.onLocalEntityChange(entity);
    }
    res.json(entity);
  });

  // Remove observation
  router.delete('/api/entities/:id/observations', requireScope('write', 'admin'), (req, res) => {
    const { observation } = ObservationSchema.parse(req.body);
    const existing = brain.entities.get(paramString(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (!enforceNamespace(req, res, existing.namespace, users)) return;
    const entity = brain.entities.removeObservation(
      paramString(req.params.id),
      observation,
    );
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    broadcast({ type: 'entity:updated', entity });
    if (syncManager?.isSynced(entity.namespace)) {
      syncManager.onLocalEntityChange(entity);
    }
    res.json(entity);
  });

  // Get neighbors (graph traversal)
  router.get('/api/entities/:id/neighbors', (req, res) => {
    const entity = requireEntity(brain, paramString(req.params.id), res);
    if (!entity) return;
    if (!enforceNamespace(req, res, entity.namespace, users)) return;

    const params = NeighborsQuerySchema.parse(req.query);
    const relationTypes = params.relationTypes
      ? (params.relationTypes.split(',') as RelationType[])
      : undefined;

    const result = brain.traversal.getNeighbors(
      paramString(req.params.id),
      params.depth ?? 1,
      relationTypes,
    );

    // Include the seed entity itself in the response
    res.json({
      entities: [entity, ...result.entities],
      relations: result.relations,
    });
  });

  return router;
}
