/**
 * Server-side denylist redaction (defense in depth).
 *
 * Re-runs the same regex bank as `tools/cli/src/lib/redact.ts` so a leak that
 * slips past the client (or a malicious client that disables redaction) is
 * still caught before the DB write. Also reuses
 * `stripPrivateBlocks()` from `services/observation-service.ts` for the
 * `<private>...</private>` envelope.
 *
 * MUST stay in sync with tools/cli/src/lib/redact.ts.
 */
import type { Request, Response, NextFunction } from 'express';
import { stripPrivateBlocks } from '../services/observation-service.js';

/**
 * Built-in denylist regexes (per plan §B.4).
 * Each entry is `[pattern, replacement]`. The replacement is a fixed
 * `[REDACTED:<kind>]` token — we never preserve the matched secret.
 */
export const BUILTIN_DENYLIST: Array<readonly [RegExp, string]> = [
  // PEM private keys — block whole bodies (multiline).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:pem]'],

  // Cloud / SaaS specific tokens
  [/AWS_SECRET_ACCESS_KEY=\S+/g, '[REDACTED:aws]'],
  [/AWS_ACCESS_KEY_ID=\S+/g, '[REDACTED:aws]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws]'],
  [/GH_TOKEN=\S+/g, '[REDACTED:github]'],
  [/GITHUB_TOKEN=\S+/g, '[REDACTED:github]'],
  [/\bgh[poursu]_[A-Za-z0-9]{30,}\b/g, '[REDACTED:github]'],
  [/GITLAB_TOKEN=\S+/g, '[REDACTED:gitlab]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:gitlab]'],
  [/OPENAI_API_KEY=\S+/g, '[REDACTED:openai]'],
  [/ANTHROPIC_API_KEY=\S+/g, '[REDACTED:anthropic]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:anthropic]'],
  // OpenAI sk-* (excludes sk-ant-)
  [/\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g, '[REDACTED:openai]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:google]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED:npm]'],

  // Generic key=value secret shapes (case-insensitive). Order matters: catch
  // explicit ENV-style assignments first, then the looser key:value form.
  // The `\S+` is constrained to non-`<>` chars so we don't swallow trailing
  // markup like `</private>` from already-stripped blocks (defensive — the
  // private-block stripper runs before us, but tightening keeps callers safe).
  [/[A-Z_]+_(KEY|SECRET|TOKEN|PASSWORD)=[^\s<>]+/g, '[REDACTED:env-secret]'],
  // Bearer/api-key/etc. assignment OR space-separated value (covers
  // `Authorization: Bearer xyz`, `api_key=xyz`, `password: xyz`).
  [/(?:api[_-]?key|secret|password|token|bearer)\s*[:=]\s*[^\s<>]+/gi, '[REDACTED:generic]'],
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/g, '[REDACTED:bearer]'],
];

export interface RedactionResult {
  redacted: string;
  count: number;
}

/** Apply the built-in denylist + private-block stripper to a string. */
export function redactString(input: string, extra?: readonly RegExp[]): RedactionResult {
  // Strip <private>...</private> blocks FIRST so the denylist patterns
  // (which use \S+) can't accidentally swallow trailing markup like
  // `</private>` and corrupt the surrounding text.
  const { redacted: afterPrivate, stripped } = stripPrivateBlocks(input);
  let working = afterPrivate;
  let count = stripped;
  for (const [pattern, replacement] of BUILTIN_DENYLIST) {
    working = working.replace(pattern, () => {
      count++;
      return replacement;
    });
  }
  for (const pattern of extra ?? []) {
    working = working.replace(pattern, () => {
      count++;
      return '[REDACTED:custom]';
    });
  }
  return { redacted: working, count };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively redact every string in a JSON-ish value.
 * Mutates and returns the same shape with a redaction counter.
 */
export function redactValue(value: unknown, extra?: readonly RegExp[]): { value: unknown; count: number } {
  if (typeof value === 'string') {
    const r = redactString(value, extra);
    return { value: r.redacted, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const r = redactValue(item, extra);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  if (isPlainObject(value)) {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(v, extra);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

export interface RedactMiddlewareOptions {
  /** Additional admin-supplied regexes (compiled by caller). */
  extraPatterns?: readonly RegExp[];
  /** Path prefixes to redact — defaults to /api/observe/. */
  paths?: string[];
  /** Optional counter callback so observe routes can increment metrics. */
  onRedaction?: (count: number) => void;
}

const DEFAULT_REDACT_PATHS = ['/api/observe/'];

/**
 * Express middleware: walks `req.body` and rewrites the `tool_input` /
 * `tool_response` (and a small list of related) keys with redacted values.
 * Only applies to the configured path prefixes; bodies on other routes
 * pass through untouched (we don't want to corrupt e.g. /api/import payloads).
 */
export function redactMiddleware(options: RedactMiddlewareOptions = {}) {
  const paths = options.paths ?? DEFAULT_REDACT_PATHS;
  return function (req: Request, _res: Response, next: NextFunction): void {
    if (!paths.some((p) => req.path.startsWith(p))) return next();
    if (isPlainObject(req.body)) {
      const body = req.body;
      let total = 0;
      // Per plan §F: redact tool_input / tool_response bodies (and the
      // adjacent `input` / `output` fields used by the Zod schemas in
      // routes/observe.ts) before any DB write. The `prompt` field on
      // /api/observe/prompt-submit is left to observation-service so
      // its `private_blocks_filtered` counter remains accurate.
      for (const key of ['input', 'output', 'tool_input', 'tool_response']) {
        if (key in body) {
          const r = redactValue(body[key], options.extraPatterns);
          body[key] = r.value;
          total += r.count;
        }
      }
      if (total > 0 && options.onRedaction) options.onRedaction(total);
    }
    next();
  };
}
