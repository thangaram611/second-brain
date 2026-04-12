import { sqliteTable, text, real, integer, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const entities = sqliteTable(
  'entities',
  {
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
  },
  (table) => [
    index('idx_entities_type_namespace').on(table.type, table.namespace),
    index('idx_entities_name').on(table.name),
    index('idx_entities_namespace_updated').on(table.namespace, table.updatedAt),
  ],
);

export const relations = sqliteTable(
  'relations',
  {
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
  },
  (table) => [
    index('idx_relations_source_type').on(table.sourceId, table.type),
    index('idx_relations_target_type').on(table.targetId, table.type),
    index('idx_relations_namespace_type').on(table.namespace, table.type),
    uniqueIndex('idx_relations_unique_edge').on(table.sourceId, table.targetId, table.type),
  ],
);

export const embeddings = sqliteTable('embeddings', {
  entityId: text('entity_id')
    .primaryKey()
    .references(() => entities.id, { onDelete: 'cascade' }),
  vector: blob('vector'),
  model: text('model').notNull(),
  createdAt: text('created_at').notNull(),
});
