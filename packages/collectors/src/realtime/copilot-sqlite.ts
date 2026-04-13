import * as os from 'node:os';
import * as path from 'node:path';
import { createSqlitePoller, type SqlitePollerHandle } from '../watch/sqlite-poller.js';
import { PostClient } from './post-client.js';

export interface CopilotSqlitePollerOptions {
  /** Override the Copilot DB path (default ~/.copilot/session-store.db). */
  dbPath?: string;
  client?: PostClient;
  persistWatermarkPath?: string;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

interface CopilotSessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  updated_at: string;
}

interface CopilotCheckpointRow {
  id: number;
  session_id: string;
  checkpoint_number: number;
  title: string;
  overview: string | null;
  history: string | null;
  work_done: string | null;
  technical_details: string | null;
  important_files: string | null;
  next_steps: string | null;
  updated_at: string;
}

interface CopilotSessionFileRow {
  session_id: string;
  file_path: string;
  tool_name: string;
  first_seen_at: string;
}

interface CopilotSessionRefRow {
  session_id: string;
  ref_type: string;
  ref_value: string;
  turn_index: number;
  first_seen_at: string;
}

/**
 * Poll the Copilot session-store.db for new/updated sessions and derived
 * artifacts (checkpoints, files, refs). Checkpoints carry Copilot's own
 * pre-materialized summaries — promoted directly as decision entities.
 */
export function createCopilotSqlitePoller(options: CopilotSqlitePollerOptions = {}): SqlitePollerHandle {
  const dbPath = options.dbPath ?? path.join(os.homedir(), '.copilot', 'session-store.db');
  const client = options.client ?? new PostClient();
  const onError = options.onError ?? ((err) => console.error('[copilot-sqlite]', err));

  return createSqlitePoller<CopilotSessionRow>({
    dbPath,
    query: `
      SELECT id, cwd, repository, branch, summary, updated_at
      FROM sessions
      WHERE updated_at > ?
      ORDER BY updated_at ASC
      LIMIT 500
    `,
    sinceColumn: 'updated_at',
    initialValue: '',
    intervalMs: options.intervalMs ?? 30_000,
    persistWatermarkPath:
      options.persistWatermarkPath ??
      path.join(os.homedir(), '.second-brain', 'sqlite-watermarks.json'),
    onError,
    onRows: async (rows) => {
      for (const session of rows) {
        const sessionId = `copilot-${session.id}`;
        try {
          await client.post('/api/observe/session-start', {
            sessionId,
            tool: 'copilot',
            cwd: session.cwd ?? undefined,
          });

          await relay(client, dbPath, session, sessionId);
        } catch (err) {
          onError(err);
        }
      }
    },
  });
}

async function relay(
  client: PostClient,
  dbPath: string,
  session: CopilotSessionRow,
  sessionId: string,
): Promise<void> {
  // Pull everything associated with this session in a single readonly open.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  try {
    const checkpoints = db
      .prepare<[string], CopilotCheckpointRow>(
        `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number ASC`,
      )
      .all(session.id);
    for (const cp of checkpoints) {
      await client.post('/api/observe/tool-use', {
        sessionId,
        toolName: 'copilot.checkpoint',
        phase: 'post',
        input: {
          checkpointNumber: cp.checkpoint_number,
          title: cp.title,
          overview: cp.overview,
          work_done: cp.work_done,
          technical_details: cp.technical_details,
          next_steps: cp.next_steps,
          history: cp.history,
          important_files: cp.important_files ? cp.important_files.split('\n').map((s) => s.trim()).filter(Boolean) : [],
        },
      });
    }

    const files = db
      .prepare<[string], CopilotSessionFileRow>(
        `SELECT session_id, file_path, tool_name, first_seen_at FROM session_files WHERE session_id = ?`,
      )
      .all(session.id);
    if (files.length > 0) {
      await client.post('/api/observe/tool-use', {
        sessionId,
        toolName: 'copilot.session_files',
        phase: 'post',
        filePaths: files.map((f) => f.file_path),
        input: files,
      });
    }

    const refs = db
      .prepare<[string], CopilotSessionRefRow>(
        `SELECT session_id, ref_type, ref_value, turn_index, first_seen_at FROM session_refs WHERE session_id = ?`,
      )
      .all(session.id);
    for (const r of refs) {
      await client.post('/api/observe/tool-use', {
        sessionId,
        toolName: 'copilot.session_ref',
        phase: 'post',
        input: { refType: r.ref_type, refValue: r.ref_value, turnIndex: r.turn_index },
      });
    }

    await client.post('/api/observe/session-end', {
      sessionId,
      reason: 'copilot-sqlite',
    });
  } finally {
    db.close();
  }
}
