import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { createSqlitePoller } from '../watch/sqlite-poller.js';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-poller-'));
  dbPath = path.join(tmp, 'test.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT)`);
  db.close();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('createSqlitePoller', () => {
  it('delivers rows above the watermark and advances it', async () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO messages (updated_at, body) VALUES (?, ?)`).run('2026-04-13T10:00:00Z', 'first');
    db.close();

    const received: unknown[] = [];
    const handle = createSqlitePoller<{ id: number; updated_at: string; body: string }>({
      dbPath,
      query: `SELECT id, updated_at, body FROM messages WHERE updated_at > ? ORDER BY updated_at ASC`,
      sinceColumn: 'updated_at',
      initialValue: '',
      intervalMs: 1_000_000,
      onRows: (rows) => {
        received.push(...rows);
      },
    });

    await handle.runOnce();
    expect(received).toHaveLength(1);
    expect(handle.watermark()).toBe('2026-04-13T10:00:00Z');

    const db2 = new Database(dbPath);
    db2.prepare(`INSERT INTO messages (updated_at, body) VALUES (?, ?)`).run('2026-04-13T11:00:00Z', 'second');
    db2.close();

    await handle.runOnce();
    expect(received).toHaveLength(2);
    expect(handle.watermark()).toBe('2026-04-13T11:00:00Z');

    handle.close();
  });

  it('never mutates the foreign database', async () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO messages (updated_at, body) VALUES (?, ?)`).run('2026-04-13T09:00:00Z', 'seed');
    db.close();

    const handle = createSqlitePoller({
      dbPath,
      query: `SELECT id, updated_at, body FROM messages WHERE updated_at > ?`,
      sinceColumn: 'updated_at',
      initialValue: '',
      intervalMs: 1_000_000,
      onRows: () => undefined,
    });
    await handle.runOnce();
    await handle.runOnce();
    handle.close();

    // DB should have exactly 1 row still.
    const db2 = new Database(dbPath, { readonly: true });
    const count = (db2.prepare(`SELECT COUNT(*) as c FROM messages`).get() as { c: number }).c;
    db2.close();
    expect(count).toBe(1);
  });

  it('persists watermark to disk', async () => {
    const wmFile = path.join(tmp, 'wm.json');
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO messages (updated_at, body) VALUES (?, ?)`).run('2026-04-13T12:00:00Z', 'a');
    db.close();

    const h1 = createSqlitePoller({
      dbPath,
      query: `SELECT id, updated_at, body FROM messages WHERE updated_at > ? ORDER BY updated_at ASC`,
      sinceColumn: 'updated_at',
      initialValue: '',
      intervalMs: 1_000_000,
      persistWatermarkPath: wmFile,
      onRows: () => undefined,
    });
    await h1.runOnce();
    expect(h1.watermark()).toBe('2026-04-13T12:00:00Z');
    await wait(20);
    h1.close();

    const raw = JSON.parse(fs.readFileSync(wmFile, 'utf8'));
    const key = Object.keys(raw)[0];
    expect(raw[key]).toBe('2026-04-13T12:00:00Z');
  });
});
