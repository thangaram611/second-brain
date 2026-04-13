import type Database from 'better-sqlite3';
import type { Migration } from './runner.js';

interface AlterSpec {
  table: 'entities' | 'relations';
  column: 'branch_context_branch' | 'branch_context_status';
  jsonPath: string;
}

const ALTERS: ReadonlyArray<AlterSpec> = [
  { table: 'entities', column: 'branch_context_branch', jsonPath: '$.branchContext.branch' },
  { table: 'entities', column: 'branch_context_status', jsonPath: '$.branchContext.status' },
  { table: 'relations', column: 'branch_context_branch', jsonPath: '$.branchContext.branch' },
  { table: 'relations', column: 'branch_context_status', jsonPath: '$.branchContext.status' },
];

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entities_branch ON entities(branch_context_branch);
  CREATE INDEX IF NOT EXISTS idx_entities_branch_status
    ON entities(branch_context_branch, branch_context_status);
  CREATE INDEX IF NOT EXISTS idx_relations_branch ON relations(branch_context_branch);
  CREATE INDEX IF NOT EXISTS idx_relations_branch_status
    ON relations(branch_context_branch, branch_context_status);
`;

function hasColumnNamed(row: unknown, needle: string): boolean {
  if (typeof row !== 'object' || row === null) return false;
  if (!('name' in row)) return false;
  return row.name === needle;
}

function addColumnIfMissing(sqlite: Database.Database, spec: AlterSpec): void {
  // NOTE: must use PRAGMA table_xinfo (not table_info) — generated columns
  // added via ALTER TABLE are hidden from table_info but appear in xinfo.
  const rows: unknown[] = sqlite.prepare(`PRAGMA table_xinfo(${spec.table})`).all();
  if (rows.some((r) => hasColumnNamed(r, spec.column))) return;
  sqlite.exec(
    `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} TEXT ` +
      `GENERATED ALWAYS AS (json_extract(properties, '${spec.jsonPath}')) VIRTUAL`,
  );
}

/**
 * v2 — Phase 10.1 foundation. Adds virtual generated columns projecting
 * `properties.branchContext.{branch,status}` so queries filtering on
 * WIP branches or specific branch names are O(log n) instead of full
 * JSON-scans. Applied to both entities and relations so
 * `flipBranchStatus` can UPDATE ... WHERE branch_context_branch = ? on
 * each table in one prepared statement.
 *
 * Idempotent via a table_info probe before each ALTER — avoids the
 * ALTER-then-catch pattern which can mask real failures.
 */
export const migration002: Migration = {
  version: 2,
  name: 'branch-context-columns',
  up(sqlite: Database.Database) {
    for (const spec of ALTERS) {
      addColumnIfMissing(sqlite, spec);
    }
    sqlite.exec(INDEXES_SQL);
  },
};
