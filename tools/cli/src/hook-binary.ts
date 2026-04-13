#!/usr/bin/env node
/**
 * brain-hook — thin hook bridge invoked by Claude Code (or compatible tools)
 * to forward lifecycle events to a running apps/server. Reads the hook JSON
 * payload from stdin, POSTs to the matching /api/observe/* endpoint, and
 * prints any hookSpecificOutput (e.g. SessionStart context block) to stdout.
 *
 * Failure policy: never exit non-zero. The user's AI session must never be
 * blocked or interrupted by this process. Failures are logged to
 * ~/.second-brain/hook.log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendFileSync } from 'node:fs';

type HookName =
  | 'session-start'
  | 'prompt-submit'
  | 'tool-use'
  | 'stop'
  | 'session-end';

const ENDPOINT: Record<HookName, string> = {
  'session-start': '/api/observe/session-start',
  'prompt-submit': '/api/observe/prompt-submit',
  'tool-use': '/api/observe/tool-use',
  stop: '/api/observe/stop',
  'session-end': '/api/observe/session-end',
};

function logFilePath(): string {
  const dir = process.env.BRAIN_HOOK_LOG_DIR ?? path.join(os.homedir(), '.second-brain');
  return path.join(dir, 'hook.log');
}

function log(line: string): void {
  try {
    const p = logFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(argv: string[]): { hook: HookName; phase?: 'pre' | 'post' } {
  // argv[2] is the hook name; optional --phase follows.
  const hook = argv[2] as HookName | undefined;
  if (!hook || !(hook in ENDPOINT)) {
    throw new Error(`unknown hook: ${hook}`);
  }
  let phase: 'pre' | 'post' | undefined;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--phase' && i + 1 < argv.length) {
      const p = argv[i + 1];
      if (p === 'pre' || p === 'post') phase = p;
    }
  }
  return { hook, phase };
}

export interface ClaudeHookPayload {
  session_id?: string;
  sessionId?: string;
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  reason?: string;
  [k: string]: unknown;
}

/**
 * Map the raw Claude Code hook payload (snake_case) onto the body the server
 * expects (camelCase + a few enrichments).
 */
export function buildRequestBody(
  hook: HookName,
  phase: 'pre' | 'post' | undefined,
  payload: ClaudeHookPayload,
): Record<string, unknown> {
  const sessionId = payload.sessionId ?? payload.session_id ?? 'unknown';
  const timestamp = new Date().toISOString();

  switch (hook) {
    case 'session-start':
      return {
        sessionId,
        cwd: payload.cwd,
        tool: 'claude',
        hookVersion: '1',
        timestamp,
      };
    case 'prompt-submit':
      return {
        sessionId,
        prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
        timestamp,
      };
    case 'tool-use':
      return {
        sessionId,
        toolName: String(payload.tool_name ?? 'unknown'),
        phase: phase ?? 'post',
        input: payload.tool_input,
        output: payload.tool_response,
        timestamp,
        filePaths: extractFilePaths(payload.tool_input, payload.tool_response),
      };
    case 'stop':
      return { sessionId, timestamp };
    case 'session-end':
      return { sessionId, reason: payload.reason, timestamp };
  }
}

function extractFilePaths(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) collectPaths(v, out);
  return [...out];
}

function collectPaths(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    // Heuristic: absolute-ish paths or paths with file extensions.
    if (/^(\/|~|\.\.?\/).+/.test(value) || /\.(ts|tsx|js|jsx|py|md|json|yaml|yml|go|rs|sql)$/i.test(value)) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectPaths(v, out);
  }
}

export interface RunOptions {
  fetchImpl?: typeof fetch;
  now?: () => string;
}

export async function runHook(argv: string[], stdin: string, opts: RunOptions = {}): Promise<number> {
  try {
    const { hook, phase } = parseArgs(argv);
    const payload: ClaudeHookPayload = stdin.trim() ? JSON.parse(stdin) : {};
    const body = buildRequestBody(hook, phase, payload);

    const port = Number(process.env.BRAIN_API_PORT ?? 7430);
    const url = `http://127.0.0.1:${port}${ENDPOINT[hook]}`;
    const token = process.env.BRAIN_AUTH_TOKEN;

    const timeoutMs = hook === 'session-start' ? 500 : 100;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const doFetch = opts.fetchImpl ?? fetch;
    let responseText = '';
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      responseText = await res.text();
      if (!res.ok) {
        log(`[${hook}] server ${res.status}: ${responseText.slice(0, 200)}`);
      }
    } catch (err) {
      log(`[${hook}] fetch failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // For SessionStart, write the hookSpecificOutput envelope that Claude Code
    // consumes to inject context. The server returns a JSON body that may
    // contain { contextBlock }; wrap it up.
    if (hook === 'session-start') {
      let contextBlock = '';
      try {
        const parsed = JSON.parse(responseText || '{}');
        if (parsed && typeof parsed.contextBlock === 'string') contextBlock = parsed.contextBlock;
      } catch {
        // ignore
      }
      if (contextBlock) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: contextBlock,
            },
          }),
        );
      }
    }

    return 0;
  } catch (err) {
    log(`[brain-hook] unexpected: ${(err as Error).message}`);
    return 0; // Never fail the session.
  }
}

// Entry point for node.
// When loaded as a module (tests), don't auto-run.
const invokedDirectly = typeof process !== 'undefined'
  && process.argv[1]
  && /brain-hook(\.(js|mjs|cjs))?$/.test(process.argv[1]);

if (invokedDirectly) {
  readStdin().then((stdin) => runHook(process.argv, stdin)).then((code) => {
    process.exit(code);
  });
}
