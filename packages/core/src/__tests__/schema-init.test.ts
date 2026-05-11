import { describe, expect, it } from 'vitest';
import { StorageDatabase } from '../storage/database.js';
import { initializeStorageSchema } from '../storage/schema-init.js';

function names(rows: Array<{ name: string }>): string[] {
  return rows.map((row) => row.name);
}

describe('StorageDatabase schema initialization', () => {
  it('creates the current tables directly', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table')")
      .all() as Array<{ name: string }>;

    expect(names(tables)).toEqual(
      expect.arrayContaining(['entities', 'relations', 'embeddings', 'entities_fts']),
    );
    db.close();
  });

  it('is idempotent when the schema is initialized repeatedly', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const before = db.sqlite
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')")
      .get() as { count: number };

    initializeStorageSchema(db.sqlite);

    const after = db.sqlite
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')")
      .get() as { count: number };

    expect(after.count).toBe(before.count);
    db.close();
  });

  it('creates branch_context virtual columns and indexes on entities and relations', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const entityColumns = db.sqlite
      .prepare('PRAGMA table_xinfo(entities)')
      .all() as Array<{ name: string }>;
    const relationColumns = db.sqlite
      .prepare('PRAGMA table_xinfo(relations)')
      .all() as Array<{ name: string }>;

    expect(names(entityColumns)).toEqual(
      expect.arrayContaining(['branch_context_branch', 'branch_context_status']),
    );
    expect(names(relationColumns)).toEqual(
      expect.arrayContaining(['branch_context_branch', 'branch_context_status']),
    );

    const indexes = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_branch%'")
      .all() as Array<{ name: string }>;
    expect(names(indexes)).toEqual(
      expect.arrayContaining([
        'idx_entities_branch',
        'idx_entities_branch_status',
        'idx_relations_branch',
        'idx_relations_branch_status',
      ]),
    );
    db.close();
  });

  it('creates a partial composite index on (namespace, source_ref)', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const indexes = db.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_entities_namespace_source_ref'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
    db.close();
  });

  it('filters entities by source_ref via the composite index', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const now = new Date().toISOString();
    const insert = db.sqlite.prepare(
      `INSERT INTO entities (id, type, name, source_type, source_ref, namespace, event_time, ingest_time, created_at, updated_at)
       VALUES (?, 'file', ?, 'git', ?, 'project-a', ?, ?, ?, ?)`,
    );
    insert.run('e1', 'src/auth.ts', 'src/auth.ts', now, now, now, now);
    insert.run('e2', 'src/login.tsx', 'src/login.tsx', now, now, now, now);
    insert.run('e3', 'README.md', 'README.md', now, now, now, now);
    insert.run('e4', 'src/auth.ts', 'src/auth.ts', now, now, now, now);
    db.sqlite
      .prepare(
        `INSERT INTO entities (id, type, name, source_type, source_ref, namespace, event_time, ingest_time, created_at, updated_at)
         VALUES ('e5', 'file', 'src/auth.ts', 'git', 'src/auth.ts', 'project-b', ?, ?, ?, ?)`,
      )
      .run(now, now, now, now);

    const rows = db.sqlite
      .prepare('SELECT id FROM entities WHERE namespace = ? AND source_ref = ? ORDER BY id')
      .all('project-a', 'src/auth.ts') as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['e1', 'e4']);

    const plan = db.sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM entities WHERE namespace = ? AND source_ref = ?')
      .all('project-a', 'src/auth.ts') as Array<{ detail: string }>;
    const planText = plan.map((row) => row.detail).join('\n');
    expect(planText).toMatch(/idx_entities_namespace_source_ref/);
    db.close();
  });

  it('filters entities by branch_context_branch via the generated-column index', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const now = new Date().toISOString();
    db.sqlite
      .prepare(
        `INSERT INTO entities (id, type, name, properties, event_time, ingest_time, source_type, created_at, updated_at)
         VALUES (?, 'event', ?, ?, ?, ?, 'watch', ?, ?)`,
      )
      .run(
        'a',
        'e:a',
        JSON.stringify({ branchContext: { branch: 'feat/x', status: 'wip' } }),
        now,
        now,
        now,
        now,
      );
    db.sqlite
      .prepare(
        `INSERT INTO entities (id, type, name, properties, event_time, ingest_time, source_type, created_at, updated_at)
         VALUES (?, 'event', ?, ?, ?, ?, 'watch', ?, ?)`,
      )
      .run(
        'b',
        'e:b',
        JSON.stringify({ branchContext: { branch: 'feat/y', status: 'wip' } }),
        now,
        now,
        now,
        now,
      );

    const rows = db.sqlite
      .prepare('SELECT id FROM entities WHERE branch_context_branch = ?')
      .all('feat/x') as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['a']);
    db.close();
  });

  it('indexes JSON-array observations and tags into FTS without rebuilding on startup', () => {
    const db = new StorageDatabase({ path: ':memory:', wal: false });
    const now = new Date().toISOString();
    db.sqlite
      .prepare(
        `INSERT INTO entities (id, type, name, observations, tags, event_time, ingest_time, source_type, created_at, updated_at)
         VALUES (?, 'fact', ?, ?, ?, ?, ?, 'manual', ?, ?)`,
      )
      .run(
        'fact-1',
        'FTS probe',
        JSON.stringify(['needle in observation']),
        JSON.stringify(['searchtag']),
        now,
        now,
        now,
        now,
      );

    const rows = db.sqlite
      .prepare(
        `SELECT e.id FROM entities_fts
         JOIN entities e ON e.rowid = entities_fts.rowid
         WHERE entities_fts MATCH ?`,
      )
      .all('needle OR searchtag') as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['fact-1']);
    db.close();
  });
});
