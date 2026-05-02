#!/usr/bin/env node
/**
 * brain-hook — thin hook bridge invoked by Claude Code, Cursor, Codex CLI,
 * or GitHub Copilot CLI to forward lifecycle events to a running apps/server.
 *
 * Reads the hook JSON payload from stdin, redacts secret-shaped tokens via
 * the client-side denylist, POSTs to the matching `/api/observe/*` endpoint,
 * and prints the per-adapter context envelope to stdout when the server
 * returns a `contextBlock` field.
 *
 * Failure policy: never exit non-zero. The user's AI session must never be
 * blocked or interrupted by this process. Failures are logged to
 * ~/.second-brain/hook.log.
 *
 * PR2 changes (vs baseline):
 *   - `--adapter <claude|cursor|codex|copilot>` flag (default `claude`).
 *   - Per-event timeouts: session-start 500ms; prompt-submit & tool-use
 *     --phase pre 250ms; tool-use --phase post / stop / session-end 100ms.
 *   - `cwd` forwarded on every event (not just session-start).
 *   - Per-adapter envelope shapes (Claude/Codex camelCase + hookEventName,
 *     Cursor snake_case, Copilot observe-only).
 *   - Client-side redact bank applied before POST.
 *   - Honors `BRAIN_HOOK_DISABLE=1` and `~/.second-brain/.brain-paused`.
 *   - Auth via `resolve-token.ts` (env → credentials + keychain → none).
 *   - All stderr is suppressed; diagnostics go only to ~/.second-brain/hook.log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { redactRequestBody, isEnvFilePath } from './lib/redact.js';

type HookName =
  | 'session-start'
  | 'prompt-submit'
  | 'tool-use'
  | 'stop'
  | 'session-end';

type AdapterName = 'claude' | 'cursor' | 'codex' | 'copilot';
type Phase = 'pre' | 'post' | 'post-inject';

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
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseAdapter(s: string | undefined): AdapterName {
  if (s === 'cursor' || s === 'codex' || s === 'copilot' || s === 'claude') return s;
  return 'claude';
}

function parsePhase(s: string | undefined): Phase | undefined {
  if (s === 'pre' || s === 'post' || s === 'post-inject') return s;
  return undefined;
}

interface ParsedArgs {
  hook: HookName;
  phase?: Phase;
  adapter: AdapterName;
}

function parseArgs(argv: string[]): ParsedArgs {
  const hookRaw = argv[2];
  if (!hookRaw || !(hookRaw in ENDPOINT)) {
    throw new Error(`unknown hook: ${hookRaw}`);
  }
  // Narrow to HookName via the index check above.
  const hookValid: HookName | null = hookRaw === 'session-start' || hookRaw === 'prompt-submit'
    || hookRaw === 'tool-use' || hookRaw === 'stop' || hookRaw === 'session-end' ? hookRaw : null;
  if (!hookValid) throw new Error(`unknown hook: ${hookRaw}`);

  let phase: Phase | undefined;
  let adapter: AdapterName = 'claude';
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--phase' && i + 1 < argv.length) {
      phase = parsePhase(argv[i + 1]);
      i++;
    } else if (argv[i] === '--adapter' && i + 1 < argv.length) {
      adapter = parseAdapter(argv[i + 1]);
      i++;
    }
  }
  return { hook: hookValid, phase, adapter };
}

export interface HookPayload {
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

/** Map raw hook payload (snake_case) onto the body the server expects. */
export function buildRequestBody(
  hook: HookName,
  phase: Phase | undefined,
  payload: HookPayload,
  adapter: AdapterName = 'claude',
): Record<string, unknown> {
  const sessionId = (typeof payload.sessionId === 'string' ? payload.sessionId : undefined)
    ?? (typeof payload.session_id === 'string' ? payload.session_id : undefined)
    ?? 'unknown';
  const timestamp = new Date().toISOString();
  const cwdValue = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const tool: AdapterName = adapter;

  switch (hook) {
    case 'session-start':
      return {
        sessionId,
        cwd: cwdValue,
        tool,
        hookVersion: '1',
        timestamp,
      };
    case 'prompt-submit':
      return {
        sessionId,
        prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
        cwd: cwdValue,
        timestamp,
      };
    case 'tool-use':
      return {
        sessionId,
        toolName: typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown',
        // 'post-inject' (Cursor only) is treated as 'post' for the server-side
        // record; the client-side stdout envelope is what differs.
        phase: phase === 'post-inject' ? 'post' : (phase ?? 'post'),
        input: payload.tool_input,
        output: payload.tool_response,
        cwd: cwdValue,
        timestamp,
        filePaths: extractFilePaths(payload.tool_input, payload.tool_response),
      };
    case 'stop':
      return { sessionId, cwd: cwdValue, timestamp };
    case 'session-end':
      return {
        sessionId,
        cwd: cwdValue,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        timestamp,
      };
  }
}

function extractFilePaths(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) collectPaths(v, out);
  return [...out];
}

function collectPaths(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
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

/** Returns true when the hook should short-circuit (.env file Read/Edit). */
function shouldShortCircuitEnv(payload: HookPayload): boolean {
  const candidates: unknown[] = [payload.tool_input, payload.tool_response];
  for (const c of candidates) {
    if (typeof c === 'string' && isEnvFilePath(c)) return true;
    if (c && typeof c === 'object') {
      for (const v of Object.values(c)) {
        if (typeof v === 'string' && isEnvFilePath(v)) return true;
      }
    }
  }
  return false;
}

function timeoutFor(hook: HookName, phase: Phase | undefined): number {
  if (hook === 'session-start') return 500;
  if (hook === 'prompt-submit') return 250;
  if (hook === 'tool-use' && phase === 'pre') return 250;
  return 100;
}

const ResponseEnvelopeSchema = z
  .object({
    contextBlock: z.string().nullable().optional(),
    eventId: z.string().optional(),
  })
  .passthrough();

interface AdapterEnvelopeArgs {
  adapter: AdapterName;
  hook: HookName;
  phase?: Phase;
  contextBlock: string;
}

/** Produce the per-adapter stdout envelope. Empty string = nothing to write. */
export function buildEnvelope(args: AdapterEnvelopeArgs): string {
  const { adapter, hook, phase, contextBlock } = args;
  if (!contextBlock) return '';

  if (adapter === 'claude' || adapter === 'codex') {
    if (hook === 'session-start') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: contextBlock,
        },
      });
    }
    if (hook === 'prompt-submit') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: contextBlock,
        },
      });
    }
    if (hook === 'tool-use' && phase === 'pre') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: contextBlock,
        },
      });
    }
    return '';
  }

  if (adapter === 'cursor') {
    // sessionStart always emits when a contextBlock exists.
    if (hook === 'session-start') {
      return JSON.stringify({ additional_context: contextBlock });
    }
    // postToolUse injection is gated behind the env flag.
    if (hook === 'tool-use' && phase === 'post-inject') {
      if (process.env.BRAIN_CURSOR_POSTTOOL_INJECT === '1') {
        return JSON.stringify({ additional_context: contextBlock });
      }
      return '';
    }
    return '';
  }

  // Copilot: hooks are observe/policy only — no in-band injection.
  return '';
}

function isHookDisabled(): boolean {
  if (process.env.BRAIN_HOOK_DISABLE === '1') return true;
  const pausePath = path.join(os.homedir(), '.second-brain', '.brain-paused');
  return fs.existsSync(pausePath);
}

export interface RunOptions {
  fetchImpl?: typeof fetch;
  now?: () => string;
}

export async function runHook(argv: string[], stdin: string, opts: RunOptions = {}): Promise<number> {
  // Suppress all stderr to ~/.second-brain/hook.log. We replace
  // process.stderr.write with a no-op for the duration of this call so
  // that nothing leaks into the assistant's transcript.
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      log(`[stderr] ${text.trim()}`);
    } catch {
      // ignore
    }
    return true;
  }) satisfies typeof process.stderr.write;

  try {
    if (isHookDisabled()) return 0;

    const { hook, phase, adapter } = parseArgs(argv);
    const payload: HookPayload = stdin.trim() ? safeJsonParse(stdin) ?? {} : {};

    // .env short-circuit on Read/Edit — never POST.
    if (hook === 'tool-use' && shouldShortCircuitEnv(payload)) {
      log(`[${hook}] short-circuit: .env read/edit detected`);
      return 0;
    }

    const rawBody = buildRequestBody(hook, phase, payload, adapter);
    const homeDir = os.homedir();
    const body = redactRequestBody(rawBody, { homeDir });

    const port = Number(process.env.BRAIN_API_PORT ?? 7430);
    const url = `http://127.0.0.1:${port}${ENDPOINT[hook]}`;

    // Lazy-import to keep cold-start tight.
    const { buildAuthHeadersAsync } = await import('./lib/config.js');
    const authHeaders = await buildAuthHeadersAsync();

    const timeoutMs = timeoutFor(hook, phase);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const doFetch = opts.fetchImpl ?? fetch;
    let responseText = '';
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      responseText = await res.text();
      if (!res.ok) {
        log(`[${hook}] server ${res.status}: ${responseText.slice(0, 200)}`);
      }
    } catch (err) {
      log(`[${hook}] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const contextBlock = parseContextBlock(responseText);
    if (contextBlock) {
      const envelope = buildEnvelope({
        adapter,
        hook,
        phase,
        contextBlock,
      });
      if (envelope) process.stdout.write(envelope);
    }

    return 0;
  } catch (err) {
    log(`[brain-hook] unexpected: ${err instanceof Error ? err.message : String(err)}`);
    return 0; // Never fail the session.
  } finally {
    process.stderr.write = originalStderrWrite;
  }
}

function safeJsonParse(s: string): HookPayload | null {
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: HookPayload = {};
      for (const [k, v] of Object.entries(parsed)) out[k] = v;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

function parseContextBlock(responseText: string): string {
  if (!responseText) return '';
  try {
    const parsed = ResponseEnvelopeSchema.safeParse(JSON.parse(responseText));
    if (!parsed.success) return '';
    const { contextBlock } = parsed.data;
    return typeof contextBlock === 'string' ? contextBlock : '';
  } catch {
    return '';
  }
}

// Entry point for node.
const invokedDirectly = typeof process !== 'undefined'
  && process.argv[1]
  && /brain-hook(\.(js|mjs|cjs))?$/.test(process.argv[1]);

if (invokedDirectly) {
  readStdin().then((stdin) => runHook(process.argv, stdin)).then((code) => {
    process.exit(code);
  });
}
