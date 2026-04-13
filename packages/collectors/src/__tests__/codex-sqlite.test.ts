import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { createCodexSqlitePoller } from '../realtime/codex-sqlite.js';
import { PostClient } from '../realtime/post-client.js';

let tmp: string;
let dbPath: string;

function buildDb(): string {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      model TEXT,
      git_branch TEXT,
      git_sha TEXT,
      memory_mode TEXT,
      rollout_path TEXT,
      first_user_message TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE stage1_outputs (
      thread_id TEXT PRIMARY KEY,
      raw_memory TEXT,
      rollout_summary TEXT,
      generated_at TEXT
    );
  `);
  db.close();
  return dbPath;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  dbPath = path.join(tmp, 'state_5.sqlite');
  buildDb();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('createCodexSqlitePoller', () => {
  it('skips threads with memory_mode=disabled and relays enabled ones', async () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO threads VALUES ('t1','/p1','title1','2026-04-12T00:00:00Z','2026-04-12T01:00:00Z','gpt-5',null,null,'enabled','/r1','hello world',0)`).run();
    db.prepare(`INSERT INTO threads VALUES ('t2','/p2','title2','2026-04-12T00:00:00Z','2026-04-12T02:00:00Z','gpt-5',null,null,'disabled','/r2','skip me',0)`).run();
    db.prepare(`INSERT INTO stage1_outputs VALUES ('t1','raw','rollout summary','2026-04-12T01:30:00Z')`).run();
    db.close();

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new PostClient({
      baseUrl: 'http://test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          path: url.replace('http://test', ''),
          body: JSON.parse(init.body as string),
        });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    let skipped = 0;
    const poller = createCodexSqlitePoller({
      dbPath,
      client,
      intervalMs: 1_000_000,
      onSkip: () => skipped++,
    });

    await poller.runOnce();
    poller.close();

    // Expect a session-start + prompt-submit + tool-use + session-end for t1
    const sessions = calls.filter((c) => c.path === '/api/observe/session-start');
    expect(sessions).toHaveLength(1);
    expect((sessions[0].body as { sessionId: string }).sessionId).toBe('codex-t1');
    // t2 skipped
    expect(skipped).toBe(0); // t2 is filtered by SQL, not loop; ensure no miscount
    const prompts = calls.filter((c) => c.path === '/api/observe/prompt-submit');
    expect(prompts).toHaveLength(1);
    const ends = calls.filter((c) => c.path === '/api/observe/session-end');
    expect(ends).toHaveLength(1);
  });
});
