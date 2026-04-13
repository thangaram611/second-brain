/**
 * Tiny internal logger shared across second-brain packages.
 *
 * Why its own file (not console.* / a library):
 * - The MCP stdio server cannot write to stdout (that's the transport). Using
 *   `console.log` from inside a tool handler corrupts the JSON-RPC stream.
 *   This logger writes to stderr only, which stays safe under stdio.
 * - We want structured JSON lines so logs are machine-readable in production,
 *   and plain text in dev for readability. One behaviour is selected by
 *   NODE_ENV at import time.
 *
 * Not shipped here (deferred until there's a real need):
 * - file rotation: only matters when a long-running process produces
 *   substantial output; CLI runs are transient and the relay pipes to Docker.
 * - transport plugins, log levels per module, child loggers.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentThreshold(): LogLevel {
  const raw = process.env.BRAIN_LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentThreshold()];
}

const useJson = process.env.NODE_ENV === 'production' || process.env.BRAIN_LOG_FORMAT === 'json';

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  if (useJson) {
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
    };
    if (fields) Object.assign(payload, fields);
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    const prefix = `[${level}] ${scope}:`;
    const tail = fields ? ` ${JSON.stringify(fields)}` : '';
    process.stderr.write(`${prefix} ${message}${tail}\n`);
  }
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(subscope: string): Logger;
}

/** Create a scoped logger. `scope` appears with every line (e.g. "ingestion.github"). */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}.${sub}`),
  };
}
