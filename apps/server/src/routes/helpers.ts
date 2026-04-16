import type { Response } from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import type { Entity, Relation } from '@second-brain/types';
import { broadcast } from '../ws/ws-server.js';

// --- 8d: require* helpers ------------------------------------------------

/**
 * Fetch an entity or send 404. Returns `null` when the response has been sent.
 */
export function requireEntity(
  brain: Brain,
  id: string,
  res: Response,
): Entity | null {
  const entity = brain.entities.get(id);
  if (!entity) {
    res.status(404).json({ error: 'Entity not found' });
    return null;
  }
  return entity;
}

/**
 * Fetch a relation or send 404. Returns `null` when the response has been sent.
 */
export function requireRelation(
  brain: Brain,
  id: string,
  res: Response,
): Relation | null {
  const relation = brain.relations.get(id);
  if (!relation) {
    res.status(404).json({ error: 'Relation not found' });
    return null;
  }
  return relation;
}

// --- 8b: delete+broadcast+sync helpers ------------------------------------

/**
 * Delete an entity, broadcast a WS event, and notify the sync manager.
 * Returns `true` on success. Sends 404 and returns `false` on failure.
 */
export function deleteEntityWithSync(
  id: string,
  brain: Brain,
  syncManager?: SyncManager,
): boolean {
  const entity = brain.entities.get(id);
  if (!entity) return false;

  const deleted = brain.entities.delete(id);
  if (!deleted) return false;

  broadcast({ type: 'entity:deleted', id });
  if (syncManager?.isSynced(entity.namespace)) {
    syncManager.onLocalEntityDelete(id, entity.namespace);
  }
  return true;
}

/**
 * Delete a relation, broadcast a WS event, and notify the sync manager.
 * Returns `true` on success. Sends 404 and returns `false` on failure.
 */
export function deleteRelationWithSync(
  id: string,
  brain: Brain,
  syncManager?: SyncManager,
): boolean {
  const relation = brain.relations.get(id);
  if (!relation) return false;

  const deleted = brain.relations.delete(id);
  if (!deleted) return false;

  broadcast({ type: 'relation:deleted', id });
  if (syncManager?.isSynced(relation.namespace)) {
    syncManager.onLocalRelationDelete(id, relation.namespace);
  }
  return true;
}
