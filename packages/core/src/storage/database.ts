import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';
import { loadSqliteVec, createVecTable, recreateVecTable } from './vec-extension.js';
import { runMigrations, ALL_MIGRATIONS } from './migrations/index.js';

export type DrizzleDB = ReturnType<typeof createDrizzle>;

function createDrizzle(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

export interface DatabaseOptions {
  /** Path to the SQLite database file. Use ':memory:' for in-memory. */
  path: string;
  /** Enable WAL mode for better concurrent read performance. Default: true */
  wal?: boolean;
  /**
   * If set, load the sqlite-vec extension and create the vec_embeddings
   * virtual table with the given dimension at construction time.
   * Omit to keep vector search opt-in (call `enableVectorSearch()` later).
   */
  vectorDimensions?: number;
}

export class StorageDatabase {
  readonly sqlite: Database.Database;
  readonly db: DrizzleDB;
  /** Current vector embedding dimensions, or null when vector search is not enabled. */
  vectorDimensions: number | null = null;

  constructor(options: DatabaseOptions) {
    this.sqlite = new Database(options.path);

    // Enable foreign keys
    this.sqlite.pragma('foreign_keys = ON');

    // WAL mode for better performance
    if (options.wal !== false) {
      this.sqlite.pragma('journal_mode = WAL');
    }

    this.db = createDrizzle(this.sqlite);

    // Run versioned schema migrations. The runner reads PRAGMA user_version
    // and applies any migrations whose version is greater, transactionally.
    // Fails fast if the DB is from a newer build than this binary knows about.
    runMigrations(this.sqlite, ALL_MIGRATIONS);

    if (typeof options.vectorDimensions === 'number') {
      this.enableVectorSearch(options.vectorDimensions);
    }
  }

  /**
   * Load the sqlite-vec extension and create the vec_embeddings table.
   * Idempotent for the same dimension; recreates the table if dimensions change.
   */
  enableVectorSearch(dimensions: number): void {
    if (this.vectorDimensions === dimensions) return;
    if (this.vectorDimensions === null) {
      loadSqliteVec(this.sqlite);
    }
    if (this.vectorDimensions !== null && this.vectorDimensions !== dimensions) {
      recreateVecTable(this.sqlite, dimensions);
    } else {
      createVecTable(this.sqlite, dimensions);
    }
    this.vectorDimensions = dimensions;
  }

  close(): void {
    this.sqlite.close();
  }
}
