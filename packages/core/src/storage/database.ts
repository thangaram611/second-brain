import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';
import { loadSqliteVec, createVecTable, recreateVecTable } from './vec-extension.js';
import { initializeStorageSchema } from './schema-init.js';

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
    try {
      this.sqlite = new Database(options.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NODE_MODULE_VERSION') || msg.includes('ERR_DLOPEN_FAILED')) {
        throw new Error(
          `better-sqlite3 native binding failed to load — likely a Node ABI mismatch (e.g., the binding was prebuilt for one Node version and the current process is on another). ` +
            `Fix: run \`pnpm rebuild-native\` from the repo root with your current Node version active, or \`pnpm install --force\`. ` +
            `Underlying error: ${msg}`,
        );
      }
      throw err;
    }

    // Enable foreign keys
    this.sqlite.pragma('foreign_keys = ON');

    // WAL mode for better performance
    if (options.wal !== false) {
      this.sqlite.pragma('journal_mode = WAL');
    }

    this.db = createDrizzle(this.sqlite);

    initializeStorageSchema(this.sqlite);

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
