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

export function entityRoutes(brain: Brain, syncManager?: SyncManager): Router {
  const router = Router();

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
    const entity = brain.entities.get(req.params.id);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    brain.entities.touch(entity.id);
    const outbound = brain.relations.getOutbound(entity.id);
    const inbound = brain.relations.getInbound(entity.id);

    res.json({ entity, outbound, inbound });
  });

  // Create entity
  router.post('/api/entities', (req, res) => {
    const input = CreateEntitySchema.parse(req.body);
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
  router.patch('/api/entities/:id', (req, res) => {
    const patch = UpdateEntitySchema.parse(req.body);
    const entity = brain.entities.update(req.params.id, patch);
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
  router.delete('/api/entities/:id', (req, res) => {
    const entity = brain.entities.get(req.params.id);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    const deleted = brain.entities.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    broadcast({ type: 'entity:deleted', id: req.params.id });
    if (syncManager?.isSynced(entity.namespace)) {
      syncManager.onLocalEntityDelete(req.params.id, entity.namespace);
    }
    res.status(204).end();
  });

  // Add observation
  router.post('/api/entities/:id/observations', (req, res) => {
    const { observation } = ObservationSchema.parse(req.body);
    const entity = brain.entities.addObservation(req.params.id, observation);
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
  router.delete('/api/entities/:id/observations', (req, res) => {
    const { observation } = ObservationSchema.parse(req.body);
    const entity = brain.entities.removeObservation(
      req.params.id,
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
    const entity = brain.entities.get(req.params.id);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    const params = NeighborsQuerySchema.parse(req.query);
    const relationTypes = params.relationTypes
      ? (params.relationTypes.split(',') as RelationType[])
      : undefined;

    const result = brain.relations.getNeighbors(
      req.params.id,
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
