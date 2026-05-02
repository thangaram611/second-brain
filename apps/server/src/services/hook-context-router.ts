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
 * CLI hook stays an HTTP-thin shim.
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
    const { toolName, sessionId, namespace } = input;

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
    const filePath = pickFilePath(parsed.data);
    if (!filePath) return null;
    if (isQuietPath(filePath)) return null;

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

    // Inject only if the pattern matches a known entity name. We probe with a
    // FTS search; on hit we surface the result, on miss we stay quiet.
    const results = input.brain.search.search({
      query: pattern,
      namespace: input.namespace,
      limit: MAX_ENTITIES_CITED,
    });
    if (results.length === 0) return null;

    return renderBlock({
      heading: `## Entities matching "${pattern}"`,
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

function isQuietPath(path: string): boolean {
  return QUIET_PATH_PATTERNS.some((re) => re.test(path));
}

function shortPath(path: string): string {
  // Keep the trailing 60 chars max so the heading stays readable.
  if (path.length <= 60) return path;
  return `…${path.slice(path.length - 59)}`;
}

function findEntitiesBySourceRef(brain: Brain, namespace: string, sourceRef: string): Entity[] {
  // The FTS5 virtual table doesn't index `source_ref`, so we use raw SQL backed
  // by `idx_entities_namespace_source_ref` (migration 002). Drizzle's typed
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
