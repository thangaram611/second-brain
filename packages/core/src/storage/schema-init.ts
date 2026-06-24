import type Database from 'better-sqlite3';

// SINGLE SOURCE OF TRUTH for the physical SQLite schema. Everything the
// database actually contains is declared here: the four tables (entities,
// relations, embeddings, entities_fts), all 16 indexes (9 on entities, 7 on
// relations including the UNIQUE idx_relations_unique_edge), the two VIRTUAL
// generated branch_context_* columns per table, and the FTS5 virtual table
// with its sync triggers. The Drizzle model in schema/entities.ts is
// column-only (for $inferSelect/$inferInsert and the query builder) and must
// NOT duplicate any index/constraint DDL — Drizzle never emits DDL in this
// codebase, so a duplicate there would be inert and misleading.

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'personal',
    observations TEXT NOT NULL DEFAULT '[]',
    properties TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0,
    event_time TEXT NOT NULL,
    ingest_time TEXT NOT NULL,
    last_accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    source_actor TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    branch_context_branch TEXT GENERATED ALWAYS AS (json_extract(properties, '$.branchContext.branch')) VIRTUAL,
    branch_context_status TEXT GENERATED ALWAYS AS (json_extract(properties, '$.branchContext.status')) VIRTUAL
  );

  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL DEFAULT 'personal',
    properties TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0,
    weight REAL NOT NULL DEFAULT 1.0,
    bidirectional INTEGER NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    source_actor TEXT,
    event_time TEXT NOT NULL,
    ingest_time TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    branch_context_branch TEXT GENERATED ALWAYS AS (json_extract(properties, '$.branchContext.branch')) VIRTUAL,
    branch_context_status TEXT GENERATED ALWAYS AS (json_extract(properties, '$.branchContext.status')) VIRTUAL
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    vector BLOB,
    model TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT NOT NULL
  );
`;

const CREATE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entities_type_namespace ON entities(type, namespace);
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_namespace_updated ON entities(namespace, updated_at);
  CREATE INDEX IF NOT EXISTS idx_entities_event_time ON entities(event_time);
  CREATE INDEX IF NOT EXISTS idx_entities_ingest_time ON entities(ingest_time);
  CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at);
  CREATE INDEX IF NOT EXISTS idx_entities_namespace_source_ref
    ON entities(namespace, source_ref)
    WHERE source_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_branch ON entities(branch_context_branch);
  CREATE INDEX IF NOT EXISTS idx_entities_branch_status ON entities(branch_context_branch, branch_context_status);

  CREATE INDEX IF NOT EXISTS idx_relations_source_type ON relations(source_id, type);
  CREATE INDEX IF NOT EXISTS idx_relations_target_type ON relations(target_id, type);
  CREATE INDEX IF NOT EXISTS idx_relations_namespace_type ON relations(namespace, type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique_edge ON relations(source_id, target_id, type);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
  CREATE INDEX IF NOT EXISTS idx_relations_branch ON relations(branch_context_branch);
  CREATE INDEX IF NOT EXISTS idx_relations_branch_status ON relations(branch_context_branch, branch_context_status);
`;

const CREATE_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name,
    observations,
    tags,
    content=entities,
    content_rowid=rowid
  );

  CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, name, observations, tags)
    VALUES (
      NEW.rowid,
      NEW.name,
      (SELECT group_concat(value, ' ') FROM json_each(NEW.observations)),
      (SELECT group_concat(value, ' ') FROM json_each(NEW.tags))
    );
  END;

  CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, observations, tags)
    VALUES (
      'delete',
      OLD.rowid,
      OLD.name,
      (SELECT group_concat(value, ' ') FROM json_each(OLD.observations)),
      (SELECT group_concat(value, ' ') FROM json_each(OLD.tags))
    );
  END;

  CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, observations, tags)
    VALUES (
      'delete',
      OLD.rowid,
      OLD.name,
      (SELECT group_concat(value, ' ') FROM json_each(OLD.observations)),
      (SELECT group_concat(value, ' ') FROM json_each(OLD.tags))
    );
    INSERT INTO entities_fts(rowid, name, observations, tags)
    VALUES (
      NEW.rowid,
      NEW.name,
      (SELECT group_concat(value, ' ') FROM json_each(NEW.observations)),
      (SELECT group_concat(value, ' ') FROM json_each(NEW.tags))
    );
  END;
`;

export function initializeStorageSchema(sqlite: Database.Database): void {
  const createSchema = sqlite.transaction(() => {
    sqlite.exec(CREATE_TABLES_SQL);
    sqlite.exec(CREATE_INDEXES_SQL);
    sqlite.exec(CREATE_FTS_SQL);
  });
  createSchema();
}
