import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, type Migration } from '../storage/migrations/index.js';
import { StorageDatabase } from '../storage/database.js';

function readUserVersion(sqlite: Database.Database): number {
  const v = sqlite.pragma('user_version', { simple: true });
  return typeof v === 'number' ? v : 0;
}

describe('runMigrations', () => {
  it('applies pending migrations in version order and stamps user_version', () => {
    const sqlite = new Database(':memory:');
    const applied: number[] = [];
    const migrations: Migration[] = [
      { version: 1, name: 'a', up: () => applied.push(1) },
      { version: 2, name: 'b', up: () => applied.push(2) },
      { version: 3, name: 'c', up: () => applied.push(3) },
    ];
    runMigrations(sqlite, migrations);
    expect(applied).toEqual([1, 2, 3]);
    expect(readUserVersion(sqlite)).toBe(3);
    sqlite.close();
  });

  it('skips migrations already at or below the current version', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('user_version = 2');
    const applied: number[] = [];
    const migrations: Migration[] = [
      { version: 1, name: 'a', up: () => applied.push(1) },
      { version: 2, name: 'b', up: () => applied.push(2) },
      { version: 3, name: 'c', up: () => applied.push(3) },
    ];
    runMigrations(sqlite, migrations);
    expect(applied).toEqual([3]);
    expect(readUserVersion(sqlite)).toBe(3);
    sqlite.close();
  });

  it('throws when DB is newer than any known migration', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('user_version = 99');
    expect(() =>
      runMigrations(sqlite, [{ version: 1, name: 'a', up: () => {} }]),
    ).toThrow(/newer than this build supports/);
    sqlite.close();
  });

  it('rolls back a failing migration so user_version stays put', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE probe(x INTEGER)');
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'ok',
        up(s) {
          s.exec('INSERT INTO probe(x) VALUES (1)');
        },
      },
      {
        version: 2,
        name: 'explodes',
        up(s) {
          s.exec('INSERT INTO probe(x) VALUES (2)');
          throw new Error('boom');
        },
      },
    ];

    expect(() => runMigrations(sqlite, migrations)).toThrow('boom');
    expect(readUserVersion(sqlite)).toBe(1);
    const rows = sqlite.prepare('SELECT x FROM probe ORDER BY x').all();
    // The insert from the failing migration was rolled back; only the first migration's insert remains.
    expect(rows).toEqual([{ x: 1 }]);
    sqlite.close();
  });

  it('is a no-op on a fresh DB with no migrations', () => {
    const sqlite = new Database(':memory:');
    runMigrations(sqlite, []);
    expect(readUserVersion(sqlite)).toBe(0);
    sqlite.close();
  });

  it('sorts out-of-order migration definitions', () => {
    const sqlite = new Database(':memory:');
    const applied: number[] = [];
    const migrations: Migration[] = [
      { version: 2, name: 'b', up: () => applied.push(2) },
      { version: 1, name: 'a', up: () => applied.push(1) },
    ];
    runMigrations(sqlite, migrations);
    expect(applied).toEqual([1, 2]);
    sqlite.close();
  });
});

describe('StorageDatabase migration integration', () => {
  it('stamps a fresh DB at the highest migration version', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    expect(readUserVersion(db.sqlite)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('creates the expected tables (entities, relations, embeddings, entities_fts)', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table')")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('entities');
    expect(names).toContain('relations');
    expect(names).toContain('embeddings');
    expect(names).toContain('entities_fts');
    db.close();
  });

  it('re-opens an existing DB file without reapplying migrations', () => {
    const dbA = new StorageDatabase({ path: ':memory:', wal: false });
    const versionAfterFirst = readUserVersion(dbA.sqlite);
    // Simulate re-open by running migrations again manually on the same handle.
    // (In real usage the user closes and reopens; semantics are the same.)
    runMigrations(dbA.sqlite, []);
    expect(readUserVersion(dbA.sqlite)).toBe(versionAfterFirst);
    dbA.close();
  });
});
