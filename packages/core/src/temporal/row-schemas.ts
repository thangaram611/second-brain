import { z } from 'zod';
import {
  ENTITY_TYPES,
  ENTITY_SOURCE_TYPES,
  RELATION_TYPES,
  type Entity,
  type Relation,
} from '@second-brain/types';

/**
 * Parse-at-boundary Zod schemas for the RAW-SQL row shape (snake_case columns,
 * JSON columns as strings) returned by `SELECT *` on the `entities`/`relations`
 * tables via better-sqlite3 prepared statements.
 *
 * These replace the old hand-written `rawRowToEntity`/`rawRowToRelation` field
 * casts: instead of `row.x as T` we validate every column against the
 * authoritative enum/shape and transform the JSON-string columns into their
 * runtime arrays/objects, so `.parse()` returns a ready `Entity`/`Relation`.
 *
 * Drizzle `$inferSelect` rows (typed objects, JSON columns already parsed) use a
 * different shape and must NOT go through these schemas.
 */

const jsonStringArray = z.string().transform((s) => z.array(z.string()).parse(JSON.parse(s || '[]')));

const jsonStringRecord = z
  .string()
  .transform((s) => z.record(z.string(), z.unknown()).parse(JSON.parse(s || '{}')));

/** sqlite stores booleans as 0/1 integers. */
const sqliteBoolean = z.union([z.number(), z.boolean()]).transform(Boolean);

/** Raw `entities` row → assembled `Entity`. */
export const EntityRowSchema = z
  .object({
    id: z.string(),
    type: z.enum(ENTITY_TYPES),
    name: z.string(),
    namespace: z.string(),
    observations: jsonStringArray,
    properties: jsonStringRecord,
    confidence: z.number(),
    event_time: z.string(),
    ingest_time: z.string(),
    last_accessed_at: z.string().nullable(),
    access_count: z.number(),
    source_type: z.enum(ENTITY_SOURCE_TYPES),
    source_ref: z.string().nullable(),
    source_actor: z.string().nullable(),
    tags: jsonStringArray,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (row): Entity => ({
      id: row.id,
      type: row.type,
      name: row.name,
      namespace: row.namespace,
      observations: row.observations,
      properties: row.properties,
      confidence: row.confidence,
      eventTime: row.event_time,
      ingestTime: row.ingest_time,
      lastAccessedAt: row.last_accessed_at ?? row.created_at,
      accessCount: row.access_count,
      source: {
        type: row.source_type,
        ref: row.source_ref ?? undefined,
        actor: row.source_actor ?? undefined,
      },
      tags: row.tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );

/** Raw `relations` row → assembled `Relation`. */
export const RelationRowSchema = z
  .object({
    id: z.string(),
    type: z.enum(RELATION_TYPES),
    source_id: z.string(),
    target_id: z.string(),
    namespace: z.string(),
    properties: jsonStringRecord,
    confidence: z.number(),
    weight: z.number(),
    bidirectional: sqliteBoolean,
    source_type: z.enum(ENTITY_SOURCE_TYPES),
    source_ref: z.string().nullable(),
    source_actor: z.string().nullable(),
    event_time: z.string(),
    ingest_time: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (row): Relation => ({
      id: row.id,
      type: row.type,
      sourceId: row.source_id,
      targetId: row.target_id,
      namespace: row.namespace,
      properties: row.properties,
      confidence: row.confidence,
      weight: row.weight,
      bidirectional: row.bidirectional,
      source: {
        type: row.source_type,
        ref: row.source_ref ?? undefined,
        actor: row.source_actor ?? undefined,
      },
      eventTime: row.event_time,
      ingestTime: row.ingest_time,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );

/** Partial-projection row shape returned by `BitemporalQueries.getTimeline`. */
export const TimelineRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ENTITY_TYPES),
  change_type: z.enum(['created', 'updated']),
  ts: z.string(),
  confidence: z.number(),
  namespace: z.string(),
});

/**
 * Parse a raw `entities` row into an `Entity`. Throws on a malformed row —
 * a malformed core row is a real bug worth surfacing.
 */
export function parseEntityRow(row: unknown): Entity {
  return EntityRowSchema.parse(row);
}

/**
 * Parse a raw `relations` row into a `Relation`. Throws on a malformed row.
 */
export function parseRelationRow(row: unknown): Relation {
  return RelationRowSchema.parse(row);
}

/**
 * Non-throwing variant for batch/foreign-tolerant callers — returns `null`
 * when the row is malformed so the caller can skip it without aborting.
 */
export function parseEntityRowSafe(row: unknown): Entity | null {
  const parsed = EntityRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}
