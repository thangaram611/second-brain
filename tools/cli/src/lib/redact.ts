/**
 * Client-side denylist redactor (PR2 §B.4 / §G).
 *
 * The hook binary applies this BEFORE POSTing any payload to apps/server.
 * The server has its own defense-in-depth layer; this is the first line.
 *
 * Goals:
 *   1. Strip secret-shaped tokens (AWS, GitHub PATs, GitLab PATs, OpenAI,
 *      Anthropic, Slack, Google API/OAuth, npm tokens, PEM private-key bodies).
 *   2. Strip generic `key=value` patterns where the key looks secret-y.
 *   3. Short-circuit: if the input clearly references a `.env*` file, scrub
 *      the whole content rather than risk leaking lines.
 *   4. Replace the user's home directory with `~/` (privacy hygiene).
 *
 * Admin-extensible: callers may pass extra regex patterns (sourced from
 * `team.json:redact.deny` in a future patch). The exported helpers accept an
 * optional `extraDeny: RegExp[]`.
 *
 * Hard constraint (memory): NEVER use `as` casts. We use type guards and
 * return new structures.
 */

const REDACTED = '[REDACTED]';

/** Built-in regex bank. Order matters — broader patterns later. */
const DENY_PATTERNS: RegExp[] = [
  // ── AWS ─────────────────────────────────────────────────────────────────
  /AWS_SECRET_ACCESS_KEY\s*[:=]\s*\S+/gi,
  /AWS_ACCESS_KEY_ID\s*[:=]\s*\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // ── GitHub ──────────────────────────────────────────────────────────────
  /\bgh[poursu]_[A-Za-z0-9]{30,}\b/g,
  /GH_TOKEN\s*[:=]\s*\S+/gi,
  /GITHUB_TOKEN\s*[:=]\s*\S+/gi,
  // ── GitLab ──────────────────────────────────────────────────────────────
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /GITLAB_TOKEN\s*[:=]\s*\S+/gi,
  // ── Anthropic (must come BEFORE generic OpenAI sk- match) ──────────────
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /ANTHROPIC_API_KEY\s*[:=]\s*\S+/gi,
  // ── OpenAI ──────────────────────────────────────────────────────────────
  /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  /OPENAI_API_KEY\s*[:=]\s*\S+/gi,
  // ── Slack ───────────────────────────────────────────────────────────────
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // ── Google ──────────────────────────────────────────────────────────────
  /\bAIza[0-9A-Za-z_-]{35,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
  // ── npm ─────────────────────────────────────────────────────────────────
  /\bnpm_[A-Za-z0-9]{36,}\b/g,
  // ── PEM-encoded private key bodies ──────────────────────────────────────
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  // ── Generic credential `key=value` shape ────────────────────────────────
  /(api[_-]?key|secret|password|token|bearer)\s*[:=]\s*\S+/gi,
  // ── All-caps `[A-Z_]+_(KEY|SECRET|TOKEN|PASSWORD)=value` env style ─────
  /\b[A-Z][A-Z0-9_]*_(KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*\S+/g,
];

/** Admin-extensible deny array — placeholder; populated from team.json future. */
export interface RedactOptions {
  /** Additional regex patterns from team manifest. */
  extraDeny?: RegExp[];
  /** Override home dir for testing. */
  homeDir?: string;
}

/** True if a string path matches a `.env` family file (anywhere in path). */
export function isEnvFilePath(path: string): boolean {
  // Match basenames like `.env`, `.env.local`, `.env.production`,
  // including paths like `/repo/.env.development.local`.
  return /(^|\/)\.env(\..+)?$/.test(path);
}

/** Replace user-home prefix with `~/`. Idempotent. */
export function redactHome(input: string, homeDir: string): string {
  if (!homeDir) return input;
  // Replace first occurrence + all subsequent occurrences. Use split-join
  // to avoid regex-escaping the home path.
  return input.split(homeDir).join('~');
}

/** Apply the regex bank to a single string. */
export function redactString(input: string, opts: RedactOptions = {}): string {
  let out = input;
  for (const re of DENY_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  if (opts.extraDeny) {
    for (const re of opts.extraDeny) {
      // Cloning to ensure stateful (g-flag) regexes reset between strings.
      const safe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      out = out.replace(safe, REDACTED);
    }
  }
  if (opts.homeDir) {
    out = redactHome(out, opts.homeDir);
  }
  return out;
}

/**
 * Recursively walk an unknown value and redact strings. Returns a fresh
 * structure; never mutates the input.
 *
 * `.env*` short-circuit: if any string property looks like a path to an env
 * file, we replace the entire object's `content`/`output`/`tool_response`
 * fields with REDACTED. This is conservative — better to lose context than
 * leak `.env` content into the graph.
 */
export function redactValue(value: unknown, opts: RedactOptions = {}): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, opts);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, opts));
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    let envShortCircuit = false;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && isEnvFilePath(v)) {
        envShortCircuit = true;
      }
      obj[k] = v;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (envShortCircuit && (k === 'content' || k === 'output' || k === 'tool_response' || k === 'file_text')) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redactValue(v, opts);
    }
    return out;
  }
  return value;
}

/**
 * Top-level entry point: redact a request body just before fetch. Mutates
 * are forbidden — returns a fresh object. The full payload object is walked.
 */
export function redactRequestBody(
  body: Record<string, unknown>,
  opts: RedactOptions = {},
): Record<string, unknown> {
  const result = redactValue(body, opts);
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    // `redactValue` always returns a plain object literal here (we built it
    // ourselves above), so we can rebuild the typed Record without a cast.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result)) out[k] = v;
    return out;
  }
  // Defensive — should never happen because input is a record.
  return body;
}

/** Used by tests to enumerate the built-in bank without exposing it. */
export function _builtinPatternsCount(): number {
  return DENY_PATTERNS.length;
}
