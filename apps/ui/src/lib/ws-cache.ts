import type { Entity, Relation, SyncStatus } from './types.js';
import type { ParallelWorkConflict } from './api.js';

/**
 * Accumulated graph cache value. The graph explorer merges neighbours across
 * fetches into a single Map keyed by entity id, plus a deduped relation list.
 * The WebSocket handlers and graph mutations patch this immutably.
 */
export interface GraphData {
  entities: Map<string, Entity>;
  relations: Relation[];
}

export const emptyGraphData: GraphData = { entities: new Map(), relations: [] };

/** Merge fetched entities/relations into prior cache, preserving dedup. */
export function mergeGraphData(
  prev: GraphData | undefined,
  next: { entities: Entity[]; relations: Relation[] },
): GraphData {
  const entities = new Map(prev?.entities);
  for (const entity of next.entities) {
    entities.set(entity.id, entity);
  }
  const existingIds = new Set((prev?.relations ?? []).map((r) => r.id));
  const newRelations = next.relations.filter((r) => !existingIds.has(r.id));
  return { entities, relations: [...(prev?.relations ?? []), ...newRelations] };
}

/** Replace the full graph cache with a fresh entity set + relation list. */
export function setGraphData(next: { entities: Entity[]; relations: Relation[] }): GraphData {
  const entities = new Map<string, Entity>();
  for (const entity of next.entities) {
    entities.set(entity.id, entity);
  }
  return { entities, relations: next.relations };
}

export function upsertEntity(prev: GraphData | undefined, entity: Entity): GraphData {
  const entities = new Map(prev?.entities);
  entities.set(entity.id, entity);
  return { entities, relations: prev?.relations ?? [] };
}

export function deleteEntity(prev: GraphData | undefined, id: string): GraphData {
  const entities = new Map(prev?.entities);
  entities.delete(id);
  const relations = (prev?.relations ?? []).filter(
    (r) => r.sourceId !== id && r.targetId !== id,
  );
  return { entities, relations };
}

export function addRelation(prev: GraphData | undefined, relation: Relation): GraphData {
  const relations = prev?.relations ?? [];
  if (relations.some((r) => r.id === relation.id)) {
    return { entities: prev?.entities ?? new Map(), relations };
  }
  return { entities: prev?.entities ?? new Map(), relations: [...relations, relation] };
}

export function deleteRelation(prev: GraphData | undefined, id: string): GraphData {
  return {
    entities: prev?.entities ?? new Map(),
    relations: (prev?.relations ?? []).filter((r) => r.id !== id),
  };
}

/** Drop a contradiction by its relation id from the cached list. */
export function removeContradiction<T extends { relation: { id: string } }>(
  prev: T[] | undefined,
  relationId: string,
): T[] {
  return (prev ?? []).filter((c) => c.relation.id !== relationId);
}

/** Patch a single namespace's sync status (state + connected peer count). */
export function patchSyncStatus(
  prev: SyncStatus[] | undefined,
  namespace: string,
  patch: Partial<Pick<SyncStatus, 'state' | 'connectedPeers'>>,
): SyncStatus[] {
  return (prev ?? []).map((st) =>
    st.namespace === namespace ? { ...st, ...patch } : st,
  );
}

/** Prepend a new parallel-work conflict, deduping by entityId. */
export function prependConflict(
  prev: ParallelWorkConflict[] | undefined,
  conflict: ParallelWorkConflict,
): ParallelWorkConflict[] {
  const existing = prev ?? [];
  if (existing.some((c) => c.entityId === conflict.entityId)) return existing;
  return [conflict, ...existing];
}
