import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chokidar from 'chokidar';
import { createJsonlTail, type JsonlTailHandle } from '../watch/jsonl-tail.js';
import { mapCopilotEnvelope, type CopilotObservation } from './parsers/copilot-events.js';
import { PostClient } from './post-client.js';

export interface CopilotTailerOptions {
  /** Override the Copilot data dir (defaults to ~/.copilot). */
  dataDir?: string;
  /** Override the POST client. */
  client?: PostClient;
  /** Persist tail offsets here (defaults to ~/.second-brain/tail-offsets.json). */
  persistOffsetPath?: string;
  /** Idle window (ms) after which we emit session-end heuristically. */
  idleMs?: number;
  onError?: (err: unknown) => void;
}

export interface CopilotTailerHandle {
  close(): Promise<void>;
  readonly counters: { lines: number; sessionEndHeuristic: number };
}

/**
 * Watch ~/.copilot/session-state/ for new session directories. For each,
 * tail events.jsonl and forward observations to /api/observe/*.
 *
 * Session-end detection is hybrid:
 *   1. Explicit session.end event in the tail (primary).
 *   2. Idle for `idleMs` (default 15min) without new lines (fallback).
 *
 * Both fire-once-per-session via a per-session latch.
 */
export function createCopilotTailer(options: CopilotTailerOptions = {}): CopilotTailerHandle {
  const dataDir = options.dataDir ?? path.join(os.homedir(), '.copilot');
  const sessionRoot = path.join(dataDir, 'session-state');
  const idleMs = options.idleMs ?? 15 * 60 * 1000;
  const persistOffsetPath =
    options.persistOffsetPath ?? path.join(os.homedir(), '.second-brain', 'tail-offsets.json');
  const client = options.client ?? new PostClient();
  const onError = options.onError ?? ((err) => console.error('[copilot-tailer]', err));

  const counters = { lines: 0, sessionEndHeuristic: 0 };
  const tails: Map<string, JsonlTailHandle> = new Map();
  const idleTimers: Map<string, NodeJS.Timeout> = new Map();
  const ended: Set<string> = new Set();

  const resetIdle = (sessionId: string) => {
    const existing = idleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      if (ended.has(sessionId)) return;
      ended.add(sessionId);
      counters.sessionEndHeuristic += 1;
      try {
        await client.post('/api/observe/session-end', { sessionId, reason: 'idle' });
      } catch (err) {
        onError(err);
      }
    }, idleMs);
    idleTimers.set(sessionId, t);
  };

  const handleObservation = async (obs: CopilotObservation) => {
    counters.lines += 1;
    resetIdle(obs.sessionId);
    try {
      switch (obs.kind) {
        case 'session-start':
          await client.post('/api/observe/session-start', {
            sessionId: obs.sessionId,
            tool: 'copilot',
            cwd: obs.payload.cwd as string | undefined,
          });
          break;
        case 'prompt':
          if (obs.prompt.trim()) {
            await client.post('/api/observe/prompt-submit', {
              sessionId: obs.sessionId,
              prompt: obs.prompt,
            });
          }
          break;
        case 'assistant-text':
          if (obs.text.trim()) {
            await client.post('/api/observe/prompt-submit', {
              sessionId: obs.sessionId,
              prompt: `[assistant] ${obs.text}`,
            });
          }
          break;
        case 'tool-request':
          await client.post('/api/observe/tool-use', {
            sessionId: obs.sessionId,
            toolName: obs.toolName,
            phase: 'pre',
            input: obs.input,
          });
          break;
        case 'session-end':
          if (!ended.has(obs.sessionId)) {
            ended.add(obs.sessionId);
            await client.post('/api/observe/session-end', {
              sessionId: obs.sessionId,
              reason: obs.reason ?? 'event',
            });
          }
          break;
        case 'other':
          await client.post('/api/observe/tool-use', {
            sessionId: obs.sessionId,
            toolName: obs.type,
            phase: 'unknown',
            input: obs.rawPayload,
          });
          break;
      }
    } catch (err) {
      onError(err);
    }
  };

  const spawnTail = (sessionDir: string) => {
    const sessionId = path.basename(sessionDir);
    const file = path.join(sessionDir, 'events.jsonl');
    if (tails.has(sessionId)) return;
    const handle = createJsonlTail({
      filePath: file,
      persistOffsetPath,
      onLine: async (value) => {
        const mapped = mapCopilotEnvelope(sessionId, value);
        if (mapped) await handleObservation(mapped);
      },
      onError,
    });
    tails.set(sessionId, handle);
  };

  // Prime existing sessions.
  try {
    for (const entry of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) spawnTail(path.join(sessionRoot, entry.name));
    }
  } catch {
    // session-state dir may not exist yet
  }

  const watcher = chokidar.watch(sessionRoot, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
  });
  watcher.on('addDir', (dir) => spawnTail(dir));
  watcher.on('error', onError);

  return {
    async close() {
      for (const t of tails.values()) t.close();
      for (const t of idleTimers.values()) clearTimeout(t);
      await watcher.close();
    },
    counters,
  };
}
