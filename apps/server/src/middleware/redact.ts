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
 *
 * **MUST stay in sync with `tools/cli/src/lib/redact.ts:DENY_PATTERNS`**.
 * The patterns match the CLI's case-insensitive `\s*[:=]\s*` form so a
 * payload that the CLI redacts will be redacted identically here. There is
 * a sync test in `__tests__/redact.test.ts` that fails if a CLI sample slips
 * past either layer.
 */
export const BUILTIN_DENYLIST: Array<readonly [RegExp, string]> = [
  // PEM private keys — block whole bodies (multiline).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:pem]'],

  // ── AWS ────────────────────────────────────────────────────────────────
  [/AWS_SECRET_ACCESS_KEY\s*[:=]\s*\S+/gi, '[REDACTED:aws]'],
  [/AWS_ACCESS_KEY_ID\s*[:=]\s*\S+/gi, '[REDACTED:aws]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws]'],
  // ── GitHub ─────────────────────────────────────────────────────────────
  [/GH_TOKEN\s*[:=]\s*\S+/gi, '[REDACTED:github]'],
  [/GITHUB_TOKEN\s*[:=]\s*\S+/gi, '[REDACTED:github]'],
  [/\bgh[poursu]_[A-Za-z0-9]{30,}\b/g, '[REDACTED:github]'],
  // ── GitLab ─────────────────────────────────────────────────────────────
  [/GITLAB_TOKEN\s*[:=]\s*\S+/gi, '[REDACTED:gitlab]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:gitlab]'],
  // ── Anthropic (must come BEFORE generic OpenAI sk- match) ─────────────
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:anthropic]'],
  [/ANTHROPIC_API_KEY\s*[:=]\s*\S+/gi, '[REDACTED:anthropic]'],
  // ── OpenAI ─────────────────────────────────────────────────────────────
  [/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:openai]'],
  [/OPENAI_API_KEY\s*[:=]\s*\S+/gi, '[REDACTED:openai]'],
  // ── Slack ──────────────────────────────────────────────────────────────
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack]'],
  // ── Google ─────────────────────────────────────────────────────────────
  [/\bAIza[0-9A-Za-z_-]{35,}\b/g, '[REDACTED:google]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:google]'],
  // ── npm ────────────────────────────────────────────────────────────────
  [/\bnpm_[A-Za-z0-9]{36,}\b/g, '[REDACTED:npm]'],

  // Generic credential `key=value` shape (case-insensitive). Order matters:
  // catch the looser `(api_key|secret|password|token|bearer): value` form
  // BEFORE the broader `[A-Z_]+_(KEY|SECRET|TOKEN|PASSWORD)=value` shape so
  // both trigger on the same input.
  [/(api[_-]?key|secret|password|token|bearer)\s*[:=]\s*\S+/gi, '[REDACTED:generic]'],
  // HTTP `Authorization: Bearer <token>` (space-separated). Catches the case
  // where a header is logged verbatim.
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/g, '[REDACTED:bearer]'],
  // All-caps env-style: `MY_API_KEY=value`, `SOME_SECRET: value`, etc.
  [/\b[A-Z][A-Z0-9_]*_(KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*\S+/g, '[REDACTED:env-secret]'],
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
