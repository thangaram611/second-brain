import type Database from 'better-sqlite3';

export interface Migration {
  /** Sequential version number (1, 2, 3, ...). */
  version: number;
  /** Short human label for logs — not load-bearing. */
  name: string;
  /** Apply the migration. Must be idempotent: safe to run twice. */
  up: (sqlite: Database.Database) => void;
}

function readUserVersion(sqlite: Database.Database): number {
  const row = sqlite.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

function writeUserVersion(sqlite: Database.Database, version: number): void {
  // PRAGMA user_version does not support parameter binding, so the integer is
  // inlined directly. Migration versions are defined in source, never user input.
  sqlite.pragma(`user_version = ${version}`);
}

/**
 * Apply pending migrations in version order. If the DB is NEWER than the
 * highest migration known to this build, throw — don't risk partial reads
 * against unknown schema.
 */
export function runMigrations(
  sqlite: Database.Database,
  migrations: ReadonlyArray<Migration>,
): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = readUserVersion(sqlite);

  if (sorted.length > 0) {
    const highestKnown = sorted[sorted.length - 1].version;
    if (current > highestKnown) {
      throw new Error(
        `Database schema version ${current} is newer than this build supports (max ${highestKnown}). ` +
          `Upgrade the binary, or use a matching older DB file.`,
      );
    }
  }

  const pending = sorted.filter((m) => m.version > current);
  for (const m of pending) {
    const tx = sqlite.transaction(() => {
      m.up(sqlite);
    });
    tx();
    writeUserVersion(sqlite, m.version);
  }
}
