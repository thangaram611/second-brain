import type { Entity, EntityType, Relation, RelationType } from '@second-brain/types';

/**
 * Maps a raw SQLite row (snake_case columns) to an Entity.
 * Used by temporal queries and search engine when operating on raw SQL results.
 */
export function rawRowToEntity(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    type: row.type as EntityType,
    name: row.name as string,
    namespace: row.namespace as string,
    observations: JSON.parse((row.observations as string) || '[]'),
    properties: JSON.parse((row.properties as string) || '{}'),
    confidence: row.confidence as number,
    eventTime: row.event_time as string,
    ingestTime: row.ingest_time as string,
    lastAccessedAt: (row.last_accessed_at as string) ?? (row.created_at as string),
    accessCount: row.access_count as number,
    source: {
      type: row.source_type as Entity['source']['type'],
      ref: (row.source_ref as string) ?? undefined,
      actor: (row.source_actor as string) ?? undefined,
    },
    tags: JSON.parse((row.tags as string) || '[]'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Maps a raw SQLite row (snake_case columns) to a Relation.
 */
export function rawRowToRelation(row: Record<string, unknown>): Relation {
  return {
    id: row.id as string,
    type: row.type as RelationType,
    sourceId: row.source_id as string,
    targetId: row.target_id as string,
    namespace: row.namespace as string,
    properties: JSON.parse((row.properties as string) || '{}'),
    confidence: row.confidence as number,
    weight: row.weight as number,
    bidirectional: Boolean(row.bidirectional),
    source: {
      type: row.source_type as Relation['source']['type'],
      ref: (row.source_ref as string) ?? undefined,
      actor: (row.source_actor as string) ?? undefined,
    },
    eventTime: row.event_time as string,
    ingestTime: row.ingest_time as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
