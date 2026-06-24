import { sqliteTable, text, real, integer, blob } from 'drizzle-orm/sqlite-core';

// This Drizzle model is intentionally COLUMN-ONLY: it exists solely for
// `$inferSelect`/`$inferInsert` type inference and the query builder. The
// physical schema — tables, all indexes, the `branch_context_*` generated
// columns, FTS5 and triggers — is owned exclusively by
// storage/schema-init.ts (the single source of truth). Do NOT re-add
// index/uniqueIndex/constraint DDL here; it would not be emitted at runtime
// (drizzle() never runs migrations in this codebase) and would only mislead.
export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  namespace: text('namespace').notNull().default('personal'),
  observations: text('observations', { mode: 'json' }).$type<string[]>().notNull().default([]),
  properties: text('properties', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  confidence: real('confidence').notNull().default(1.0),
  eventTime: text('event_time').notNull(),
  ingestTime: text('ingest_time').notNull(),
  lastAccessedAt: text('last_accessed_at'),
  accessCount: integer('access_count').notNull().default(0),
  sourceType: text('source_type').notNull(),
  sourceRef: text('source_ref'),
  sourceActor: text('source_actor'),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const relations = sqliteTable('relations', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  sourceId: text('source_id')
    .notNull()
    .references(() => entities.id, { onDelete: 'cascade' }),
  targetId: text('target_id')
    .notNull()
    .references(() => entities.id, { onDelete: 'cascade' }),
  namespace: text('namespace').notNull().default('personal'),
  properties: text('properties', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  confidence: real('confidence').notNull().default(1.0),
  weight: real('weight').notNull().default(1.0),
  bidirectional: integer('bidirectional', { mode: 'boolean' }).notNull().default(false),
  sourceType: text('source_type').notNull(),
  sourceRef: text('source_ref'),
  sourceActor: text('source_actor'),
  eventTime: text('event_time').notNull(),
  ingestTime: text('ingest_time').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const embeddings = sqliteTable('embeddings', {
  entityId: text('entity_id')
    .primaryKey()
    .references(() => entities.id, { onDelete: 'cascade' }),
  vector: blob('vector'),
  model: text('model').notNull(),
  contentHash: text('content_hash'),
  createdAt: text('created_at').notNull(),
});
