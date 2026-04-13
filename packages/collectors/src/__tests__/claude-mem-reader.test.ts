import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { ingestClaudeMemOnce } from '../realtime/claude-mem-reader.js';
import { PostClient } from '../realtime/post-client.js';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mem-'));
  dbPath = path.join(tmp, 'claude-mem.db');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ingestClaudeMemOnce', () => {
  it('returns disabled when DB is absent', async () => {
    const result = await ingestClaudeMemOnce({
      dbPath: path.join(tmp, 'missing.db'),
    });
    expect(result.disabled).toMatch(/not found/);
  });

  it('imports rows from recognized tables as reference observations', async () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE observations (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE irrelevant (id INTEGER, other INTEGER);
    `);
    db.prepare(`INSERT INTO observations (content) VALUES (?)`).run('first fact');
    db.prepare(`INSERT INTO observations (content) VALUES (?)`).run('second fact');
    db.close();

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new PostClient({
      baseUrl: 'http://t',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ path: url.replace('http://t', ''), body: JSON.parse(init.body as string) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    const result = await ingestClaudeMemOnce({ dbPath, client });

    expect(result.tablesSeen).toContain('observations');
    expect(result.importedReferences).toBe(2);
    const starts = calls.filter((c) => c.path === '/api/observe/session-start');
    expect(starts).toHaveLength(1);
    const toolUses = calls.filter((c) => c.path === '/api/observe/tool-use');
    expect(toolUses).toHaveLength(2);
    const contents = toolUses.map((c) => (c.body.input as { content: string }).content);
    expect(contents).toEqual(expect.arrayContaining(['first fact', 'second fact']));
  });

  it('never writes to the claude-mem DB (readonly open)', async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, content TEXT)`);
    db.prepare(`INSERT INTO observations (content) VALUES ('x')`).run();
    db.close();

    const client = new PostClient({
      baseUrl: 'http://t',
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    await ingestClaudeMemOnce({ dbPath, client });

    const db2 = new Database(dbPath, { readonly: true });
    const count = (db2.prepare(`SELECT COUNT(*) as c FROM observations`).get() as { c: number }).c;
    db2.close();
    expect(count).toBe(1);
  });
});
