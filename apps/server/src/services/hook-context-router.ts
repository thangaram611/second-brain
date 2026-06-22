import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { Brain } from '@second-brain/core';
import { rawRowToEntity } from '@second-brain/core';
import type { Entity, SearchResult } from '@second-brain/types';
import { buildRecallContextBlock } from '@second-brain/mcp-server';
import { HookContextCache, PER_SESSION_BYTE_CAP } from './hook-context-cache.js';

/**
 * Server-side per-tool context router for the assistant-hook UX.
 *
 * Reads the inbound hook event (`PreToolUse`, `UserPromptSubmit`) and returns a
 * compact markdown block that the assistant injects into its model context.
 * Stays within strict caps (4KB per block, 32KB cumulative per session, 8 entities,
 * 280-char truncated observations) — see plan §A. All work is server-side; the
 * CLI hook stays an HTTP-thin adapter.
 *
 * Quiet-mode rules return `null`:
 *  - empty entity set
 *  - path matches `node_modules/`, `dist/`, `*.lock`, `.git/`, `package-lock.json`
 *  - prompt < 12 chars
 *  - duplicate of an injection within the last 30s of the session (cache hit)
 *  - cumulative session bytes ≥ 32KB
 *  - tool starts with `mcp__second-brain__` (model is already querying us)
 */

const MAX_BLOCK_BYTES = 4 * 1024;
const MAX_ENTITIES_CITED = 8;
const MAX_OBSERVATION_CHARS = 280;
const MIN_PROMPT_CHARS = 12;

const QUIET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.git\//,
  /\.lock$/,
  /(^|\/)package-lock\.json$|^package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$|^pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$|^yarn\.lock$/,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)\.turbo\//,
  /(^|\/)coverage\//,
];

const BASH_TAG_TOOLS = new Set(['git', 'pnpm', 'npm', 'yarn', 'cargo', 'make', 'psql', 'sqlite3']);

export interface RouteContextInput {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  sessionId: string;
  namespace: string;
  brain: Brain;
}

export interface RouteContextResult {
  contextBlock: string | null;
  cacheKey: string;
}

/**
 * Loose Zod parser for tool input — every assistant ships a slightly different
 * shape, so we accept the union and pick the fields we recognize. Anything we
 * can't parse falls back to quiet-mode null.
 */
const ReadEditWriteInputSchema = z.object({
  file_path: z.string().optional(),
  filePath: z.string().optional(),
  path: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  content: z.string().optional(),
});

const MultiEditInputSchema = z.object({
  file_path: z.string().optional(),
  filePath: z.string().optional(),
  path: z.string().optional(),
  edits: z
    .array(
      z.object({
        old_string: z.string().optional(),
        new_string: z.string().optional(),
      }),
    )
    .optional(),
});

const BashInputSchema = z.object({
  command: z.string().optional(),
  cmd: z.string().optional(),
});

const GrepGlobInputSchema = z.object({
  pattern: z.string().optional(),
  query: z.string().optional(),
  path: z.string().optional(),
});

const PromptInputSchema = z.object({
  prompt: z.string().optional(),
});

/** Schema for the partial-row shape we read off `entities` via raw SQL. */
const EntityLookupRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  namespace: z.string(),
  observations: z.string(),
  properties: z.string(),
  confidence: z.number(),
  event_time: z.string(),
  ingest_time: z.string(),
  last_accessed_at: z.string().nullable(),
  access_count: z.number(),
  source_type: z.string(),
  source_ref: z.string().nullable(),
  source_actor: z.string().nullable(),
  tags: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export class HookContextRouter {
  constructor(private readonly cache: HookContextCache) {}

  /**
   * Public entry — returns `{ contextBlock, cacheKey }` for any inbound hook
   * event. `contextBlock` is `null` when any quiet-mode rule fires. The
   * `cacheKey` is always populated so callers can correlate.
   */
  async routeContext(input: RouteContextInput): Promise<RouteContextResult> {
    const { toolName, sessionId } = input;

    // Always-quiet: model is calling our own MCP server.
    if (toolName.startsWith('mcp__second-brain__')) {
      return { contextBlock: null, cacheKey: `${sessionId}:${toolName}:mcp-suppressed` };
    }

    // Per-session cumulative cap.
    if (this.cache.getSessionBytes(sessionId) >= PER_SESSION_BYTE_CAP) {
      return { contextBlock: null, cacheKey: `${sessionId}:${toolName}:cap-hit` };
    }

    const cacheKey = this.cache.blockCacheKey(sessionId, toolName, input.toolInput);
    const cached = this.cache.getBlock(cacheKey);
    if (cached !== undefined) {
      // Dedup window — return null even if the original block had content,
      // per plan §A "duplicate of an injection within the last 30s of the
      // session (cache hit) → return null".
      return { contextBlock: null, cacheKey };
    }

    const block = await this.dispatch(input);
    const trimmed = block === null ? null : truncateBlock(block);

    // Cache the *outcome* (null or block); both deduplicate on repeat invocations.
    const bytes = trimmed ? Buffer.byteLength(trimmed, 'utf8') : 0;
    this.cache.setBlock(cacheKey, { contextBlock: trimmed, bytes });
    if (trimmed && bytes > 0) {
      this.cache.addSessionBytes(sessionId, bytes);
    }

    return { contextBlock: trimmed, cacheKey };
  }

  // ─── Per-tool dispatch ────────────────────────────────────────────────

  private async dispatch(input: RouteContextInput): Promise<string | null> {
    const { toolName } = input;

    // Pseudo-tool from prompt-submit: any non-empty toolName matching `prompt-submit`
    // is treated as a prompt route. Callers that don't have a tool name pass `''`.
    if (toolName === '' || toolName === 'prompt-submit') {
      return this.routePrompt(input);
    }

    if (toolName === 'Read') return this.routeReadLike(input, /*withSearch*/ false);
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
      return this.routeReadLike(input, /*withSearch*/ true);
    }
    if (toolName === 'Bash') return this.routeBash(input);
    if (toolName === 'Grep' || toolName === 'Glob') return this.routeGrepGlob(input);

    // Unknown tool — observe-only.
    return null;
  }

  private async routePrompt(input: RouteContextInput): Promise<string | null> {
    const parsed = PromptInputSchema.safeParse(input.toolInput);
    const prompt = parsed.success ? (parsed.data.prompt ?? '').trim() : '';
    if (prompt.length < MIN_PROMPT_CHARS) return null;
    const block = await buildRecallContextBlock(input.brain, {
      query: prompt,
      namespaces: [input.namespace],
      limit: MAX_ENTITIES_CITED,
      includeParallelWork: true,
    });
    return normalizeEmpty(block);
  }

  private async routeReadLike(
    input: RouteContextInput,
    withSearch: boolean,
  ): Promise<string | null> {
    const parsed =
      input.toolName === 'MultiEdit'
        ? MultiEditInputSchema.safeParse(input.toolInput)
        : ReadEditWriteInputSchema.safeParse(input.toolInput);
    if (!parsed.success) return null;
    const rawFilePath = pickFilePath(parsed.data);
    if (!rawFilePath) return null;
    if (isQuietPath(rawFilePath)) return null;

    // Normalize relative paths against the session cwd. Skip injection entirely
    // when the path is relative and we have no cwd to anchor it (don't guess).
    const filePath = normalizePathToCwd(rawFilePath, input.cwd);
    if (filePath === null) return null;

    const matches = findEntitiesBySourceRef(input.brain, input.namespace, filePath);

    let related: SearchResult[] = [];
    if (withSearch) {
      const symbol = extractSymbol(parsed.data);
      if (symbol) {
        related = await input.brain.search.searchMulti({
          query: symbol,
          namespace: input.namespace,
          limit: MAX_ENTITIES_CITED,
        });
      }
    }

    const collisions = input.brain.findParallelWork({
      pathLike: filePath,
      namespace: input.namespace,
      limit: 10,
    });

    if (matches.length === 0 && related.length === 0 && collisions.length === 0) {
      return null;
    }

    return renderBlock({
      heading: `## Context for ${input.toolName} ${shortPath(filePath)}`,
      entities: matches,
      related,
      collisions,
    });
  }

  private async routeBash(input: RouteContextInput): Promise<string | null> {
    const parsed = BashInputSchema.safeParse(input.toolInput);
    if (!parsed.success) return null;
    const command = (parsed.data.command ?? parsed.data.cmd ?? '').trim();
    if (!command) return null;

    const firstToken = command.split(/\s+/)[0] ?? '';

    // Try path-shaped commands first (cat, less, head, tail, grep against a file).
    // If we extract a path arg, normalize it against cwd and look up entities by
    // source_ref (mirrors routeReadLike).
    const pathArg = extractBashPathArg(command);
    if (pathArg !== null && !isQuietPath(pathArg)) {
      const normalized = normalizePathToCwd(pathArg, input.cwd);
      if (normalized !== null) {
        const matches = findEntitiesBySourceRef(input.brain, input.namespace, normalized);
        if (matches.length > 0) {
          return renderBlock({
            heading: `## Context for Bash ${firstToken} ${shortPath(normalized)}`,
            entities: matches,
            related: [],
            collisions: [],
          });
        }
      }
    }

    if (!BASH_TAG_TOOLS.has(firstToken)) return null;

    const results = await input.brain.search.searchMulti({
      query: firstToken,
      namespace: input.namespace,
      limit: MAX_ENTITIES_CITED,
    });
    if (results.length === 0) return null;

    return renderBlock({
      heading: `## Recent ${firstToken} context`,
      entities: [],
      related: results,
      collisions: [],
    });
  }

  private async routeGrepGlob(input: RouteContextInput): Promise<string | null> {
    const parsed = GrepGlobInputSchema.safeParse(input.toolInput);
    if (!parsed.success) return null;
    const pattern = (parsed.data.pattern ?? parsed.data.query ?? '').trim();
    if (!pattern) return null;
    if (pattern.length < 3) return null; // single-char regex would match anything

    // Optional search root — normalize relative roots against cwd. If a relative
    // root is given but no cwd is set, skip injection rather than guess.
    const rawRoot = parsed.data.path;
    let normalizedRoot: string | null = null;
    if (typeof rawRoot === 'string' && rawRoot.length > 0) {
      normalizedRoot = normalizePathToCwd(rawRoot, input.cwd);
      if (normalizedRoot === null) return null;
    }

    // Inject only if the pattern matches a known entity name. We probe with a
    // FTS search; on hit we surface the result, on miss we stay quiet.
    const results = input.brain.search.search({
      query: pattern,
      namespace: input.namespace,
      limit: MAX_ENTITIES_CITED,
    });
    if (results.length === 0) return null;

    const heading = normalizedRoot
      ? `## Entities matching "${pattern}" under ${shortPath(normalizedRoot)}`
      : `## Entities matching "${pattern}"`;
    return renderBlock({
      heading,
      entities: [],
      related: results,
      collisions: [],
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pickFilePath(data: z.infer<typeof ReadEditWriteInputSchema> | z.infer<typeof MultiEditInputSchema>): string | null {
  return data.file_path ?? data.filePath ?? data.path ?? null;
}

function extractSymbol(
  data: z.infer<typeof ReadEditWriteInputSchema> | z.infer<typeof MultiEditInputSchema>,
): string | null {
  // For Write/Edit we look at content; for MultiEdit we coalesce edit strings.
  if ('edits' in data && Array.isArray(data.edits)) {
    const joined = data.edits
      .map((e) => `${e.old_string ?? ''} ${e.new_string ?? ''}`)
      .join('\n');
    return symbolFromText(joined);
  }
  const candidate = ('new_string' in data ? data.new_string : undefined) ?? ('content' in data ? data.content : undefined);
  if (typeof candidate === 'string' && candidate.length > 0) return symbolFromText(candidate);
  // Fall back to the file basename (without extension) — gives FTS something useful.
  const fp = pickFilePath(data);
  if (fp) {
    const base = fp.split('/').pop() ?? fp;
    return base.replace(/\.[^.]+$/, '') || null;
  }
  return null;
}

function symbolFromText(text: string): string | null {
  // Look for the first identifier-shaped token (≥3 chars). Keeps the FTS query
  // tight without parsing the language.
  const match = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/);
  return match ? match[0] : null;
}

function isQuietPath(p: string): boolean {
  return QUIET_PATH_PATTERNS.some((re) => re.test(p));
}

function shortPath(p: string): string {
  // Keep the trailing 60 chars max so the heading stays readable.
  if (p.length <= 60) return p;
  return `…${p.slice(p.length - 59)}`;
}

/**
 * Normalize a tool-arg path against the session cwd.
 *
 * Resolution order:
 *  - `~/…` or `$HOME/…` → expanded against `os.homedir()` (treated as absolute)
 *  - Absolute path → returned unchanged
 *  - Relative path with absolute, non-empty cwd → resolved against cwd
 *  - Relative path with empty/undefined cwd, OR cwd that is itself not absolute
 *    (defensive against a misconfigured upstream) → returns `null` (caller
 *    should skip injection rather than guess at a wrong path)
 *
 * Adapter-emitted paths today are absolute, so this is forward-compat plumbing
 * for future adapters that send relative paths (e.g., a hypothetical Zed
 * adapter). Plan §6.2.
 */
function normalizePathToCwd(filePath: string, cwd: string | undefined): string | null {
  // Expand `~/` and `$HOME/` against the home dir; the result is absolute.
  // Bare `~` (no trailing slash) maps to the home dir itself.
  if (filePath === '~' || filePath.startsWith('~/')) {
    const home = os.homedir();
    return filePath === '~' ? home : path.join(home, filePath.slice(2));
  }
  if (filePath === '$HOME' || filePath.startsWith('$HOME/')) {
    const home = os.homedir();
    return filePath === '$HOME' ? home : path.join(home, filePath.slice('$HOME/'.length));
  }
  if (path.isAbsolute(filePath)) return filePath;
  if (!cwd || cwd.length === 0) return null;
  // Defensive: a non-absolute cwd cannot anchor anything safely.
  if (!path.isAbsolute(cwd)) return null;
  return path.resolve(cwd, filePath);
}

/**
 * Extract a path-shaped arg from common shell command shapes — `cat <path>`,
 * `head -n 5 <path>`, `tail -F <path>`, `less <path>`, `grep PATTERN <path>`.
 * Returns `null` if no path-shaped arg is found. Best-effort, not a shell parser.
 *
 * Heuristic:
 *  - first token must be a known path-bearing command
 *  - skip flag tokens (start with `-`); when a flag is in the per-command
 *    `flagsTakingArg` set, also skip the next token (the flag's value)
 *  - skip a fixed number of leading positional args (`positionalSkips`) —
 *    e.g., `grep PATTERN <path>` skips the pattern positional
 *  - return the next non-flag positional that looks path-like (contains `/`,
 *    leading `.`, leading `~`, leading `$`, or a `.<ext>` suffix)
 *  - tokenization is quote-aware so `cat "my file.txt"` produces a single
 *    `my file.txt` token (and similarly for single quotes / escaped spaces)
 */
function extractBashPathArg(command: string): string | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens.length < 2) return null;
  const head = tokens[0];
  if (!PATH_BEARING_BASH_TOOLS.has(head)) return null;

  const flagsTakingArg = FLAGS_TAKING_ARG[head] ?? EMPTY_FLAG_SET;
  let positionalSkips = POSITIONAL_SKIPS[head] ?? 0;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      // Long-form `--flag=value` carries its value inline — never consumes the
      // next token. Short or long flags listed in `flagsTakingArg` consume the
      // immediately following token as their value.
      if (!t.includes('=') && flagsTakingArg.has(t)) {
        i++; // skip the flag's value
      }
      continue;
    }
    if (positionalSkips > 0) {
      positionalSkips--;
      continue;
    }
    if (looksLikePath(t)) return t;
    return null;
  }
  return null;
}

const PATH_BEARING_BASH_TOOLS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'wc',
  'file',
]);

const EMPTY_FLAG_SET: ReadonlySet<string> = new Set();

/**
 * Per-command flags that take a value as the NEXT token (so the tokenizer
 * needs to skip both). Only includes the common forms that show up in
 * day-to-day shell use. Long-form `--flag=value` is handled inline (no skip).
 */
const FLAGS_TAKING_ARG: Record<string, ReadonlySet<string>> = {
  head: new Set(['-n', '-c', '--lines', '--bytes']),
  tail: new Set(['-n', '-c', '--lines', '--bytes']),
  grep: new Set(['-m', '-A', '-B', '-C', '-e', '-f', '--max-count', '--after-context', '--before-context', '--context', '--regexp', '--file']),
  less: new Set(['-x', '-y', '-P', '-#']),
  wc: new Set([]),
  cat: new Set([]),
  more: new Set([]),
  file: new Set(['-f', '-m', '-F', '--separator']),
};

/** Positional args to skip BEFORE the path positional. `grep PATTERN <path>` → skip 1. */
const POSITIONAL_SKIPS: Record<string, number> = {
  grep: 1,
};

/**
 * Quote-aware shell tokenizer. Recognizes single-quoted and double-quoted
 * substrings (no nested escapes inside single quotes; backslash escapes the
 * next char outside single quotes). Concatenates adjacent quoted/unquoted
 * fragments into one token (`a"b c"` → `ab c`). Whitespace outside quotes
 * separates tokens.
 *
 * Not a full shell parser — no command substitution, no parameter expansion,
 * no globbing. Sufficient for the path-extraction heuristic above.
 */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < command.length) {
        // Inside double quotes, backslash escapes only $`"\ and newline; for
        // our purposes pass the next char through.
        current += command[i + 1];
        i++;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      i++;
      hasContent = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

function looksLikePath(t: string): boolean {
  if (t.length === 0) return false;
  // Anything with a slash, a leading `.`, leading `~`, leading `$`, or a
  // `.<ext>` suffix is path-shaped.
  if (t.includes('/')) return true;
  if (t.startsWith('.')) return true;
  if (t.startsWith('~')) return true;
  if (t.startsWith('$')) return true;
  return /\.[A-Za-z0-9]+$/.test(t);
}

function findEntitiesBySourceRef(brain: Brain, namespace: string, sourceRef: string): Entity[] {
  // The FTS5 virtual table doesn't index `source_ref`, so we use raw SQL backed
  // by `idx_entities_namespace_source_ref`. Drizzle's typed
  // builder doesn't know about every column shape we map back via
  // `rawRowToEntity`, so we go through the prepared statement directly and
  // validate the row shape with Zod.
  const stmt = brain.storage.sqlite.prepare(`
    SELECT *
    FROM entities
    WHERE namespace = ? AND source_ref = ?
    LIMIT ?
  `);
  const raw = stmt.all(namespace, sourceRef, MAX_ENTITIES_CITED);
  const out: Entity[] = [];
  for (const row of raw) {
    const parsed = EntityLookupRowSchema.safeParse(row);
    if (!parsed.success) continue;
    out.push(rawRowToEntity(parsed.data));
  }
  return out;
}

interface RenderInput {
  heading: string;
  entities: Entity[];
  related: SearchResult[];
  collisions: ReturnType<Brain['findParallelWork']>;
}

function renderBlock(input: RenderInput): string {
  const lines: string[] = [];
  if (input.collisions.length > 0) {
    lines.push('<parallel-work-alert>');
    for (const c of input.collisions.slice(0, 5)) {
      lines.push(`  ${c.entityType}: ${c.entityName} (ns=${c.namespace})`);
      lines.push(`    actors:   ${c.actors.join(', ')}`);
      lines.push(`    branches: ${c.branches.join(', ')}`);
    }
    lines.push('</parallel-work-alert>');
    lines.push('');
  }
  lines.push(input.heading);

  let cited = 0;
  for (const e of input.entities) {
    if (cited >= MAX_ENTITIES_CITED) break;
    lines.push(`- [${e.type}] **${e.name}** · ${e.id} · ns=${e.namespace}`);
    const obs = e.observations.slice(0, 5);
    for (const o of obs) {
      lines.push(`  - ${truncateObservation(o)}`);
    }
    cited++;
  }
  for (const r of input.related) {
    if (cited >= MAX_ENTITIES_CITED) break;
    const e = r.entity;
    lines.push(`- [${e.type}] **${e.name}** · ${e.id} · ns=${e.namespace} · score=${r.score.toFixed(2)}`);
    if (e.observations.length > 0) {
      lines.push(`  - ${truncateObservation(e.observations[0])}`);
    }
    cited++;
  }

  if (cited === 0 && input.collisions.length === 0) return '';
  return lines.join('\n');
}

function truncateObservation(text: string): string {
  if (text.length <= MAX_OBSERVATION_CHARS) return text;
  return `${text.slice(0, MAX_OBSERVATION_CHARS - 1)}…`;
}

function truncateBlock(block: string): string {
  const bytes = Buffer.byteLength(block, 'utf8');
  if (bytes <= MAX_BLOCK_BYTES) return block;
  // Cut on a line boundary when possible to keep markdown valid.
  const buf = Buffer.from(block, 'utf8').subarray(0, MAX_BLOCK_BYTES - 16);
  let s = buf.toString('utf8');
  const lastNl = s.lastIndexOf('\n');
  if (lastNl > 0) s = s.slice(0, lastNl);
  return `${s}\n…[truncated]`;
}

function normalizeEmpty(block: string): string | null {
  const trimmed = block.trim();
  if (trimmed.length === 0) return null;
  return block;
}
