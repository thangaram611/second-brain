import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';

export type DrizzleDB = ReturnType<typeof createDrizzle>;

function createDrizzle(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

/**
 * SQL statements to create the core tables.
 * We use raw SQL instead of Drizzle migrations for simplicity in Phase 1.
 */
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

  -- Temporal indexes for bitemporal queries
  CREATE INDEX IF NOT EXISTS idx_entities_event_time ON entities(event_time);
  CREATE INDEX IF NOT EXISTS idx_entities_ingest_time ON entities(ingest_time);
  CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
`;

/**
 * FTS5 virtual table for full-text search on entities.
 * content=entities means it reads from the entities table.
 * We use an external content table so FTS stays in sync via triggers.
 */
const CREATE_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name,
    observations,
    tags,
    content=entities,
    content_rowid=rowid
  );

  -- Triggers to keep FTS in sync with entities table.
  -- We flatten JSON arrays into space-separated text for better FTS matching.
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

export interface DatabaseOptions {
  /** Path to the SQLite database file. Use ':memory:' for in-memory. */
  path: string;
  /** Enable WAL mode for better concurrent read performance. Default: true */
  wal?: boolean;
}

export class StorageDatabase {
  readonly sqlite: Database.Database;
  readonly db: DrizzleDB;

  constructor(options: DatabaseOptions) {
    this.sqlite = new Database(options.path);

    // Enable foreign keys
    this.sqlite.pragma('foreign_keys = ON');

    // WAL mode for better performance
    if (options.wal !== false) {
      this.sqlite.pragma('journal_mode = WAL');
    }

    this.db = createDrizzle(this.sqlite);

    // Initialize schema
    this.sqlite.exec(CREATE_TABLES_SQL);
    this.sqlite.exec(CREATE_FTS_SQL);
  }

  close(): void {
    this.sqlite.close();
  }
}
