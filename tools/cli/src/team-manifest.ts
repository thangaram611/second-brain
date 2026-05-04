/**
 * `.second-brain/team.json` schema + helpers (PR4 §A).
 *
 * The manifest is the team-onboarding contract. A new member runs
 *   brain init client --invite <token>
 * which redeems the invite, then prompts to wire the repo. If a manifest is
 * present, `runWireFromManifest()` reads it and orchestrates git + adapter
 * installs. `brain doctor` later verifies the wired state matches the
 * manifest by comparing `hashTeamManifest()` against the snapshot in
 * `~/.second-brain/.wired-repos.json`.
 *
 * Hard rule (memory): no `as` casts. Use Zod safeParse + structural narrowing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Path the manifest lives at, relative to the repo root. */
export const TEAM_MANIFEST_REL_PATH = path.join('.second-brain', 'team.json');

const HttpUrl = z.url({ protocol: /^https?$/ });

const GitHookEnum = z.enum(['post-commit', 'post-merge', 'post-checkout']);
const AssistantEnum = z.enum(['claude', 'cursor', 'codex', 'copilot']);

export const TeamManifestSchema = z.object({
  // Forward-compat: keep as a literal today; widen to `z.literal([1, 2])` when
  // a v2 schema ships. Version-tag failures must surface at parse time so
  // callers don't silently misinterpret a future schema.
  version: z.literal(1),
  namespace: z.string().min(1),
  server: z.object({
    url: HttpUrl,
    relayUrl: HttpUrl.optional(),
  }),
  hooks: z
    .object({
      git: z.array(GitHookEnum).default([]),
      assistants: z.array(AssistantEnum).default([]),
      scope: z.enum(['user', 'project']).default('user'),
    })
    .optional(),
  providers: z
    .object({
      github: z
        .object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          webhookManagedBy: z.enum(['admin', 'self']).default('self'),
        })
        .optional(),
      gitlab: z
        .object({
          projectId: z.string().min(1),
          webhookManagedBy: z.enum(['admin', 'self']).default('self'),
        })
        .optional(),
    })
    .optional(),
  client: z
    .object({ mode: z.enum(['local-only', 'cache']).default('local-only') })
    .optional(),
  redact: z
    .object({ deny: z.array(z.string()).default([]) })
    .optional(),
});

export type TeamManifest = z.infer<typeof TeamManifestSchema>;

export type LoadTeamManifestResult =
  | { ok: true; manifest: TeamManifest; absPath: string }
  | {
      ok: false;
      reason: 'not-found' | 'unreadable' | 'invalid-json' | 'invalid-schema';
      absPath: string;
      detail?: string;
    };

/** Resolve absolute manifest path for a given repo root. */
export function teamManifestPath(repoRoot: string): string {
  return path.join(repoRoot, TEAM_MANIFEST_REL_PATH);
}

/** Read + parse the manifest. Never throws — returns a discriminated result. */
export function loadTeamManifest(repoRoot: string): LoadTeamManifestResult {
  const absPath = teamManifestPath(repoRoot);
  if (!fs.existsSync(absPath)) {
    return { ok: false, reason: 'not-found', absPath };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    // existsSync said the file is there but read failed (permissions, race
    // with rotation, etc) — distinguishable from genuinely-missing so callers
    // like `brain doctor` can flag it as a real problem instead of treating
    // it as a clean solo-repo case.
    return {
      ok: false,
      reason: 'unreadable',
      absPath,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid-json',
      absPath,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const result = TeamManifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: 'invalid-schema',
      absPath,
      detail: z.prettifyError(result.error),
    };
  }
  return { ok: true, manifest: result.data, absPath };
}

/**
 * Recursively canonicalize a Zod-parsed value: arrays preserve order, object
 * keys are sorted lexicographically, primitives are emitted as-is. The
 * manifest schema cannot produce cycles (Zod validates a tree of primitives,
 * arrays, and objects), so a depth-only traversal is sufficient — no
 * cycle-tracking, no `safe-stable-stringify` dep.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      const child = Reflect.get(value, k);
      if (child === undefined) continue;
      sorted[k] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 of the canonical JSON. Stable across key orderings in the input. */
export function hashTeamManifest(manifest: TeamManifest): string {
  const canonical = canonicalize(manifest);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}

export interface CompiledDenyPattern {
  source: string;
  regex: RegExp;
}

export interface CompileDenyResult {
  patterns: CompiledDenyPattern[];
  errors: Array<{ source: string; message: string }>;
}

/**
 * Compile each `redact.deny` string as a JavaScript regex. Failures surface as
 * `errors` rather than throwing — the hook redactor must keep working when
 * one entry is malformed. Manifest authors can guard the pattern with `(?i)`
 * via the `i` flag, applied automatically.
 */
export function compileExtraDenyPatterns(manifest: TeamManifest): CompileDenyResult {
  const out: CompiledDenyPattern[] = [];
  const errors: Array<{ source: string; message: string }> = [];
  const sources = manifest.redact?.deny ?? [];
  for (const src of sources) {
    try {
      out.push({ source: src, regex: new RegExp(src, 'gi') });
    } catch (e) {
      errors.push({
        source: src,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { patterns: out, errors };
}
