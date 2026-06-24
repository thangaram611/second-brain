import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { PostClient } from './post-client.js';

/** sqlite_master / PRAGMA table_info rows expose a `name` column. */
const NamedRowSchema = z.array(z.object({ name: z.string() }).passthrough());
/** Foreign data rows are intentionally loose — validate only that each is an object. */
const ForeignRowsSchema = z.array(z.record(z.string(), z.unknown()));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ClaudeMemReaderOptions {
  /** Override claude-mem DB path. Default: ~/.claude-mem/claude-mem.db */
  dbPath?: string;
  /** POST client; defaults to apps/server on 127.0.0.1. */
  client?: PostClient;
  /** Session to attribute imported observations to. Default: 'claude-mem-import'. */
  sessionId?: string;
  /** Max rows imported per table in one pass (defensive cap). */
  perTableLimit?: number;
  /** Override warn sink. */
  onWarn?: (message: string) => void;
}

export interface ClaudeMemReaderResult {
  tablesSeen: string[];
  importedReferences: number;
  /** Set when claude-mem DB is not present or schema is too foreign. */
  disabled?: string;
}

const CONTENT_COLUMNS = ['content', 'text', 'observation', 'summary', 'body', 'title'];

/**
 * Best-effort read-only adapter that imports claude-mem's stored observations
 * as `reference` entities. Schema-permissive: walks sqlite_master and ingests
 * any table whose columns include a recognized content column.
 *
 * Opt-in — only runs when the caller explicitly invokes it. See the
 * ENABLE_CLAUDE_MEM_INGEST env flag used by the CLI wrapper.
 */
export async function ingestClaudeMemOnce(
  options: ClaudeMemReaderOptions = {},
): Promise<ClaudeMemReaderResult> {
  const dbPath = options.dbPath ?? path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
  if (!fs.existsSync(dbPath)) {
    return { tablesSeen: [], importedReferences: 0, disabled: `db not found at ${dbPath}` };
  }
  const sessionId = options.sessionId ?? 'claude-mem-import';
  const perTable = options.perTableLimit ?? 500;
  const client = options.client ?? new PostClient();
  const onWarn = options.onWarn ?? ((m) => console.warn('[claude-mem]', m));

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');

  try {
    await client.post('/api/observe/session-start', {
      sessionId,
      tool: 'claude-mem',
    });

    const tables = NamedRowSchema.parse(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all(),
    );

    const seen: string[] = [];
    let imported = 0;

    for (const { name: table } of tables) {
      let columns: string[];
      try {
        columns = NamedRowSchema.parse(
          db.prepare(`PRAGMA table_info(${table})`).all(),
        ).map((c) => c.name);
      } catch (err) {
        onWarn(`skip ${table}: ${errorMessage(err)}`);
        continue;
      }
      const contentCol = CONTENT_COLUMNS.find((c) => columns.includes(c));
      if (!contentCol) continue;
      seen.push(table);

      let rows: Array<Record<string, unknown>>;
      try {
        rows = ForeignRowsSchema.parse(
          db.prepare(`SELECT rowid as __rid, * FROM ${table} LIMIT ${perTable}`).all(),
        );
      } catch (err) {
        onWarn(`skip ${table}: ${errorMessage(err)}`);
        continue;
      }

      for (const row of rows) {
        const body = String(row[contentCol] ?? '').trim();
        if (!body) continue;
        const rid = row.__rid ?? row.id ?? '';
        try {
          await client.post('/api/observe/tool-use', {
            sessionId,
            toolName: `claude-mem.${table}`,
            phase: 'post',
            input: {
              source: 'claude-mem',
              table,
              rowId: rid,
              contentColumn: contentCol,
              content: body.slice(0, 4000),
            },
          });
          imported++;
        } catch (err) {
          onWarn(`post failed for ${table} rid=${rid}: ${errorMessage(err)}`);
        }
      }
    }

    await client.post('/api/observe/session-end', {
      sessionId,
      reason: 'claude-mem-co-ingest',
    });

    return { tablesSeen: seen, importedReferences: imported };
  } finally {
    db.close();
  }
}
