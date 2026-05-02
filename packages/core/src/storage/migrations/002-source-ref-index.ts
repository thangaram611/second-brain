import type Database from 'better-sqlite3';
import type { Migration } from './runner.js';

const CREATE_SOURCE_REF_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entities_namespace_source_ref
    ON entities(namespace, source_ref)
    WHERE source_ref IS NOT NULL;
`;

export const migration002: Migration = {
  version: 2,
  name: 'source-ref-index',
  up(sqlite: Database.Database) {
    sqlite.exec(CREATE_SOURCE_REF_INDEX_SQL);
  },
};
