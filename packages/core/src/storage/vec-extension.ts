import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

/**
 * Load the sqlite-vec native extension into a better-sqlite3 connection.
 *
 * sqlite-vec ships prebuilt binaries via optional dependencies for
 * darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64.
 *
 * Throws if the extension cannot be loaded (missing binary for the platform,
 * better-sqlite3 not built with extension support, etc.).
 */
export function loadSqliteVec(db: Database.Database): void {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec: { load: (db: Database.Database) => void } = require('sqlite-vec');
  // sqlite-vec ships a `load(db)` helper that resolves the platform-specific
  // binary path and calls db.loadExtension() under the hood.
  sqliteVec.load(db);
}

/**
 * Create the `vec_embeddings` virtual table.
 * Idempotent (uses IF NOT EXISTS).
 *
 * The dimension is fixed at table creation time. Switching embedding models
 * later requires dropping and recreating this table (handled by EmbeddingStore).
 */
export function createVecTable(db: Database.Database, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`createVecTable: dimensions must be a positive integer, got ${dimensions}`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
      entity_id TEXT PRIMARY KEY,
      embedding float[${dimensions}]
    )
  `);
}

/**
 * Drop and recreate the vec_embeddings virtual table with new dimensions.
 * Used when changing embedding models with different vector sizes.
 */
export function recreateVecTable(db: Database.Database, dimensions: number): void {
  db.exec(`DROP TABLE IF EXISTS vec_embeddings`);
  createVecTable(db, dimensions);
}
