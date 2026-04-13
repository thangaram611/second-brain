import * as os from 'node:os';
import * as path from 'node:path';
import { createSqlitePoller, type SqlitePollerHandle } from '../watch/sqlite-poller.js';
import { PostClient } from './post-client.js';

export interface CodexSqlitePollerOptions {
  /** Override the Codex state DB (default ~/.codex/state_5.sqlite). */
  dbPath?: string;
  client?: PostClient;
  persistWatermarkPath?: string;
  intervalMs?: number;
  onError?: (err: unknown) => void;
  /** Counter increment when we skip a thread for memory_mode='disabled'. */
  onSkip?: () => void;
}

interface CodexThreadRow {
  id: string;
  cwd: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  model: string | null;
  git_branch: string | null;
  git_sha: string | null;
  memory_mode: string | null;
  rollout_path: string | null;
  first_user_message: string | null;
  raw_memory: string | null;
  rollout_summary: string | null;
  generated_at: string | null;
}

/**
 * Poll the Codex state DB. For each new/updated thread, post a session-start
 * + observations (consuming `stage1_outputs.rollout_summary` as the canonical
 * semantic summary) + session-end. Respects `memory_mode = 'disabled'`.
 */
export function createCodexSqlitePoller(options: CodexSqlitePollerOptions = {}): SqlitePollerHandle {
  const dbPath = options.dbPath ?? path.join(os.homedir(), '.codex', 'state_5.sqlite');
  const client = options.client ?? new PostClient();
  const onError = options.onError ?? ((err) => console.error('[codex-sqlite]', err));

  return createSqlitePoller<CodexThreadRow>({
    dbPath,
    query: `
      SELECT t.id, t.cwd, t.title, t.created_at, t.updated_at, t.model,
             t.git_branch, t.git_sha, t.memory_mode, t.rollout_path,
             t.first_user_message, s.raw_memory, s.rollout_summary, s.generated_at
      FROM threads t LEFT JOIN stage1_outputs s ON s.thread_id = t.id
      WHERE t.updated_at > ?
        AND (t.memory_mode IS NULL OR t.memory_mode != 'disabled')
        AND t.archived = 0
      ORDER BY t.updated_at ASC
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
      for (const t of rows) {
        if (t.memory_mode === 'disabled') {
          options.onSkip?.();
          continue;
        }
        const sessionId = `codex-${t.id}`;
        try {
          await client.post('/api/observe/session-start', {
            sessionId,
            tool: 'codex',
            cwd: t.cwd ?? undefined,
          });
          if (t.first_user_message) {
            await client.post('/api/observe/prompt-submit', {
              sessionId,
              prompt: t.first_user_message,
            });
          }
          if (t.rollout_summary) {
            await client.post('/api/observe/tool-use', {
              sessionId,
              toolName: 'codex.rollout_summary',
              phase: 'post',
              input: { summary: t.rollout_summary, raw: t.raw_memory },
            });
          }
          await client.post('/api/observe/session-end', {
            sessionId,
            reason: 'codex-sqlite',
          });
        } catch (err) {
          onError(err);
        }
      }
    },
  });
}
