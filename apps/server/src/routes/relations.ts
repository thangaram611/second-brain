import { Router } from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import type { RelationType } from '@second-brain/types';
import { CreateRelationSchema } from '../schemas.js';
import { broadcast } from '../ws/ws-server.js';
import { requireRelation, deleteRelationWithSync, paramString } from './helpers.js';
import { enforceNamespace, requireScope } from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';

export interface RelationRoutesOptions {
  users?: UsersService | null;
}

export function relationRoutes(
  brain: Brain,
  syncManager?: SyncManager,
  options: RelationRoutesOptions = {},
): Router {
  const router = Router();
  const users = options.users ?? null;

  // Create relation
  router.post('/api/relations', requireScope('write', 'admin'), (req, res) => {
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

    // Token must be allowed in BOTH endpoint namespaces (and the requested
    // relation namespace, which the schema validator already constrained
    // to default-or-explicit).
    const targetNs = input.namespace ?? source.namespace;
    if (!enforceNamespace(req, res, source.namespace, users)) return;
    if (!enforceNamespace(req, res, target.namespace, users)) return;
    if (!enforceNamespace(req, res, targetNs, users)) return;

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
    const relation = requireRelation(brain, paramString(req.params.id), res);
    if (!relation) return;
    if (!enforceNamespace(req, res, relation.namespace, users)) return;
    res.json(relation);
  });

  // Delete relation
  router.delete('/api/relations/:id', requireScope('write', 'admin'), (req, res) => {
    const existing = brain.relations.get(paramString(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Relation not found' });
      return;
    }
    if (!enforceNamespace(req, res, existing.namespace, users)) return;
    const deleted = deleteRelationWithSync(paramString(req.params.id), brain, syncManager);
    if (!deleted) {
      res.status(404).json({ error: 'Relation not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
