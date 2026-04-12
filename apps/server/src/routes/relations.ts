import { Router } from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import type { RelationType } from '@second-brain/types';
import { CreateRelationSchema } from '../schemas.js';
import { broadcast } from '../ws/ws-server.js';

export function relationRoutes(brain: Brain, syncManager?: SyncManager): Router {
  const router = Router();

  // Create relation
  router.post('/api/relations', (req, res) => {
    const input = CreateRelationSchema.parse(req.body);

    // Validate both entities exist
    const source = brain.entities.get(input.sourceId);
    if (!source) {
      res.status(400).json({ error: `Source entity ${input.sourceId} not found` });
      return;
    }
    const target = brain.entities.get(input.targetId);
    if (!target) {
      res.status(400).json({ error: `Target entity ${input.targetId} not found` });
      return;
    }

    const relation = brain.relations.create({
      type: input.type as RelationType,
      sourceId: input.sourceId,
      targetId: input.targetId,
      namespace: input.namespace,
      properties: input.properties,
      confidence: input.confidence,
      weight: input.weight,
      bidirectional: input.bidirectional,
      source: { type: 'manual' },
    });

    broadcast({ type: 'relation:created', relation });
    if (syncManager?.isSynced(relation.namespace)) {
      syncManager.onLocalRelationChange(relation);
    }
    res.status(201).json(relation);
  });

  // Get relation by ID
  router.get('/api/relations/:id', (req, res) => {
    const relation = brain.relations.get(req.params.id);
    if (!relation) {
      res.status(404).json({ error: 'Relation not found' });
      return;
    }
    res.json(relation);
  });

  // Delete relation
  router.delete('/api/relations/:id', (req, res) => {
    const relation = brain.relations.get(req.params.id);
    if (!relation) {
      res.status(404).json({ error: 'Relation not found' });
      return;
    }

    const deleted = brain.relations.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Relation not found' });
      return;
    }

    broadcast({ type: 'relation:deleted', id: req.params.id });
    if (syncManager?.isSynced(relation.namespace)) {
      syncManager.onLocalRelationDelete(req.params.id, relation.namespace);
    }
    res.status(204).end();
  });

  return router;
}
