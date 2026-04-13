import type Database from 'better-sqlite3';
import type { Migration } from './runner.js';

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
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entities_type_namespace ON entities(type, namespace);
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_namespace_updated ON entities(namespace, updated_at);

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
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_relations_source_type ON relations(source_id, type);
  CREATE INDEX IF NOT EXISTS idx_relations_target_type ON relations(target_id, type);
  CREATE INDEX IF NOT EXISTS idx_relations_namespace_type ON relations(namespace, type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique_edge ON relations(source_id, target_id, type);

  CREATE TABLE IF NOT EXISTS embeddings (
    entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    vector BLOB,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entities_event_time ON entities(event_time);
  CREATE INDEX IF NOT EXISTS idx_entities_ingest_time ON entities(ingest_time);
  CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
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

/**
 * v1 = the baseline schema as of Phase 7.
 *
 * Also adds the `content_hash` column to `embeddings` — prior to the migration
 * runner this was applied by an ad-hoc ALTER on every open; now it lives inside
 * the versioned initial migration. Uses IF NOT EXISTS / duplicate-column
 * tolerance so it is safe to re-run on DBs that were already partially created
 * by pre-migration code paths.
 */
export const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  up(sqlite: Database.Database) {
    sqlite.exec(CREATE_TABLES_SQL);
    sqlite.exec(CREATE_FTS_SQL);
    try {
      sqlite.exec(`ALTER TABLE embeddings ADD COLUMN content_hash TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(message)) throw err;
    }
  },
};
