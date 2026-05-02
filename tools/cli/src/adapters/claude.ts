/**
 * Claude Code adapter — full capability (Pre/Prompt/Session-start injection).
 *
 * This file owns the Claude `~/.claude/settings.json` (or project-scope
 * `<cwd>/.claude/settings.json`) lifecycle. The legacy module
 * `install-claude-hooks.ts` re-exports from here for back-compat.
 *
 * Per-tool matcher split (PR3 §C):
 *   - `Read|Edit|Write|MultiEdit|Bash|Grep|Glob` → heavy retrieval (PreToolUse).
 *   - `Task|WebFetch|WebSearch|mcp__*` → record-only (PostToolUse only).
 *
 * Sentinel `# brain:v2` is appended to every generated command for stable
 * dedup across binary path changes / version bumps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Adapter,
  AdapterInstallOptions,
  AdapterInstallResult,
  AdapterUninstallOptions,
  AdapterUninstallResult,
  AdapterDetectResult,
} from './types.js';
import { HOOK_SENTINEL } from './types.js';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/**
 * Tool matcher used for `PreToolUse` heavy-retrieval. The remaining tools
 * still get a `PostToolUse` record-only entry but no pre injection. Claude
 * matchers are regex strings.
 */
const HEAVY_PRE_MATCHER = '^(Read|Edit|Write|MultiEdit|Bash|Grep|Glob)$';

interface ClaudeHookCommand {
  type: 'command';
  command: string;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookCommand[];
}

interface ClaudeSettings {
  hooks?: Partial<Record<ClaudeHookEvent, ClaudeHookGroup[]>>;
  [k: string]: unknown;
}

interface Sidecar {
  version: 1;
  installedAt: string;
  entries: Array<{ event: ClaudeHookEvent; command: string; matcher?: string }>;
}

function brainHookCommand(event: ClaudeHookEvent, override?: string): string {
  const bin = override ?? 'brain-hook';
  // The sentinel is a comment suffix — POSIX shell ignores it but our
  // dedup logic uses it as a stable "ours" marker.
  const flag = '--adapter claude';
  switch (event) {
    case 'SessionStart':
      return `${bin} session-start ${flag} ${HOOK_SENTINEL}`;
    case 'UserPromptSubmit':
      return `${bin} prompt-submit ${flag} ${HOOK_SENTINEL}`;
    case 'PreToolUse':
      return `${bin} tool-use --phase pre ${flag} ${HOOK_SENTINEL}`;
    case 'PostToolUse':
      return `${bin} tool-use --phase post ${flag} ${HOOK_SENTINEL}`;
    case 'Stop':
      return `${bin} stop ${flag} ${HOOK_SENTINEL}`;
    case 'SessionEnd':
      return `${bin} session-end ${flag} ${HOOK_SENTINEL}`;
  }
}

function resolveSettingsPath(scope: 'user' | 'project', home: string, cwd: string): string {
  if (scope === 'user') return path.join(home, '.claude', 'settings.json');
  return path.join(cwd, '.claude', 'settings.json');
}

function resolveSidecarPath(settingsPath: string): string {
  return path.join(path.dirname(settingsPath), 'settings.brain-hooks.json');
}

/**
 * Best-effort JSON load. Returns the parsed value when it's a non-null
 * object; otherwise returns the fallback. The caller is responsible for
 * validating the structural shape (we keep this thin and pure).
 */
function loadJsonObject(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) obj[k] = v;
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

function isClaudeHookEvent(s: string): s is ClaudeHookEvent {
  for (const e of CLAUDE_HOOK_EVENTS) if (e === s) return true;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function loadHookGroups(raw: Record<string, unknown> | null): {
  settings: ClaudeSettings;
} {
  if (!raw) return { settings: {} };
  // Re-build a typed settings object from the freely-shaped raw record.
  const out: ClaudeSettings = { ...raw, hooks: {} };
  const hooks = raw.hooks;
  if (isRecord(hooks)) {
    const target: Partial<Record<ClaudeHookEvent, ClaudeHookGroup[]>> = {};
    for (const [k, v] of Object.entries(hooks)) {
      if (!isClaudeHookEvent(k)) continue;
      if (!Array.isArray(v)) continue;
      const groups: ClaudeHookGroup[] = [];
      for (const g of v) {
        if (!isRecord(g)) continue;
        const matcherCandidate = g.matcher;
        const hooksCandidate = g.hooks;
        if (!Array.isArray(hooksCandidate)) continue;
        const cmds: ClaudeHookCommand[] = [];
        for (const h of hooksCandidate) {
          if (!isRecord(h)) continue;
          const cmd = h.command;
          const type = h.type;
          if (typeof cmd === 'string' && (type === 'command' || type === undefined)) {
            cmds.push({ type: 'command', command: cmd });
          }
        }
        if (cmds.length > 0) {
          groups.push(typeof matcherCandidate === 'string'
            ? { matcher: matcherCandidate, hooks: cmds }
            : { hooks: cmds });
        }
      }
      if (groups.length > 0) target[k] = groups;
    }
    out.hooks = target;
  }
  return { settings: out };
}

function loadSidecar(p: string): Sidecar | null {
  const raw = loadJsonObject(p);
  if (!raw) return null;
  const version = raw.version;
  const installedAt = raw.installedAt;
  const entriesRaw = raw.entries;
  if (version !== 1) return null;
  if (typeof installedAt !== 'string') return null;
  if (!Array.isArray(entriesRaw)) return null;
  const entries: Sidecar['entries'] = [];
  for (const e of entriesRaw) {
    if (!isRecord(e)) continue;
    const ev = e.event;
    const cmd = e.command;
    const matcher = e.matcher;
    if (typeof ev === 'string' && isClaudeHookEvent(ev) && typeof cmd === 'string') {
      entries.push({
        event: ev,
        command: cmd,
        matcher: typeof matcher === 'string' ? matcher : undefined,
      });
    }
  }
  return { version: 1, installedAt, entries };
}

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function isClaudeMemCommand(cmd: string): boolean {
  return /\b(claude-mem|@claude-mem)\b/.test(cmd);
}

export function detectClaudeMem(settings: ClaudeSettings): boolean {
  const hooks = settings.hooks ?? {};
  for (const groups of Object.values(hooks)) {
    if (!groups) continue;
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (isClaudeMemCommand(h.command)) return true;
      }
    }
  }
  return false;
}

export function stripClaudeMem(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: {} };
  const hooks = settings.hooks ?? {};
  const target = next.hooks;
  if (!target) return next;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups) continue;
    if (!isClaudeHookEvent(event)) continue;
    const cleaned: ClaudeHookGroup[] = [];
    for (const g of groups) {
      const keep = (g.hooks ?? []).filter((h) => !isClaudeMemCommand(h.command));
      if (keep.length > 0) cleaned.push({ ...g, hooks: keep });
    }
    if (cleaned.length > 0) target[event] = cleaned;
  }
  return next;
}

interface UpsertSpec {
  event: ClaudeHookEvent;
  command: string;
  matcher?: string;
}

function upsertHook(settings: ClaudeSettings, spec: UpsertSpec): boolean {
  const hooks = settings.hooks ?? {};
  settings.hooks = hooks;
  const groups: ClaudeHookGroup[] = hooks[spec.event] ?? [];

  // Sentinel-based dedup: a `# brain:v2` comment makes our entry stable across
  // binary path changes / version bumps. We treat any existing command with the
  // same sentinel + same hook name as ours and replace it.
  const isOurs = (cmd: string): boolean => cmd.includes(HOOK_SENTINEL);
  let alreadyPresent = false;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (h.command === spec.command) {
        alreadyPresent = true;
        break;
      }
      // Replace stale ours-entries inline so we don't accumulate duplicates.
      if (isOurs(h.command)) {
        h.command = spec.command;
        alreadyPresent = true;
      }
    }
    if (alreadyPresent) break;
  }
  if (alreadyPresent) {
    hooks[spec.event] = groups;
    return false;
  }

  const newGroup: ClaudeHookGroup = spec.matcher
    ? { matcher: spec.matcher, hooks: [{ type: 'command', command: spec.command }] }
    : { hooks: [{ type: 'command', command: spec.command }] };
  groups.push(newGroup);
  hooks[spec.event] = groups;
  return true;
}

function removeHook(settings: ClaudeSettings, command: string): boolean {
  const hooks = settings.hooks;
  if (!hooks) return false;
  let removed = false;
  for (const eventStr of Object.keys(hooks)) {
    if (!isClaudeHookEvent(eventStr)) continue;
    const event = eventStr;
    const groups = hooks[event];
    if (!groups) continue;
    const cleanedGroups: ClaudeHookGroup[] = [];
    for (const g of groups) {
      const keep = (g.hooks ?? []).filter((h) => h.command !== command);
      if (keep.length !== (g.hooks?.length ?? 0)) removed = true;
      if (keep.length > 0) cleanedGroups.push({ ...g, hooks: keep });
    }
    if (cleanedGroups.length > 0) hooks[event] = cleanedGroups;
    else delete hooks[event];
  }
  return removed;
}

/** Specs for what to write per event. PreToolUse uses a tool-name matcher. */
function buildSpecs(hookCommand?: string): UpsertSpec[] {
  return [
    { event: 'SessionStart', command: brainHookCommand('SessionStart', hookCommand) },
    { event: 'UserPromptSubmit', command: brainHookCommand('UserPromptSubmit', hookCommand) },
    {
      event: 'PreToolUse',
      command: brainHookCommand('PreToolUse', hookCommand),
      matcher: HEAVY_PRE_MATCHER,
    },
    {
      event: 'PostToolUse',
      command: brainHookCommand('PostToolUse', hookCommand),
      matcher: '.*',
    },
    { event: 'Stop', command: brainHookCommand('Stop', hookCommand) },
    { event: 'SessionEnd', command: brainHookCommand('SessionEnd', hookCommand) },
  ];
}

function installImpl(opts: AdapterInstallOptions): AdapterInstallResult {
  const settingsPath = resolveSettingsPath(opts.scope, opts.home, opts.cwd);
  const sidecarPath = resolveSidecarPath(settingsPath);
  const warnings: string[] = [];

  let settings = loadHookGroups(loadJsonObject(settingsPath)).settings;
  const hasClaudeMem = detectClaudeMem(settings);

  if (hasClaudeMem && opts.skipIfClaudeMem) {
    return {
      configPath: settingsPath,
      addedEvents: [],
      auxFiles: [],
      skipped: 'claude-mem hooks present and skipIfClaudeMem was set',
      warnings,
    };
  }

  let backupPath: string | undefined;
  if (hasClaudeMem && opts.exclusive) {
    backupPath = path.join(path.dirname(settingsPath), 'settings.brain-hooks.backup.json');
    writeJson(backupPath, settings);
    settings = stripClaudeMem(settings);
  } else if (hasClaudeMem) {
    warnings.push('claude-mem hooks detected; coexisting (both will run).');
  }

  const specs = buildSpecs(opts.hookCommand);
  const added: string[] = [];
  for (const spec of specs) {
    if (upsertHook(settings, spec)) added.push(spec.event);
  }

  writeJson(settingsPath, settings);
  const sidecar: Sidecar = {
    version: 1,
    installedAt: new Date().toISOString(),
    entries: specs.map((s) => ({ event: s.event, command: s.command, matcher: s.matcher })),
  };
  writeJson(sidecarPath, sidecar);

  return {
    configPath: settingsPath,
    addedEvents: added,
    auxFiles: [sidecarPath],
    backupPath,
    warnings,
  };
}

function uninstallImpl(opts: AdapterUninstallOptions): AdapterUninstallResult {
  const settingsPath = resolveSettingsPath(opts.scope, opts.home, opts.cwd);
  const sidecarPath = resolveSidecarPath(settingsPath);
  const warnings: string[] = [];

  const settings = loadHookGroups(loadJsonObject(settingsPath)).settings;
  const sidecar = loadSidecar(sidecarPath);

  const removed: string[] = [];
  if (sidecar) {
    for (const entry of sidecar.entries) {
      if (removeHook(settings, entry.command)) removed.push(entry.event);
    }
  }

  writeJson(settingsPath, settings);
  try {
    fs.unlinkSync(sidecarPath);
  } catch {
    // ignore
  }
  return { configPath: settingsPath, removed, warnings };
}

function detectImpl(home: string, _cwd: string): AdapterDetectResult {
  const userSettings = path.join(home, '.claude', 'settings.json');
  const installed = fs.existsSync(userSettings) || fs.existsSync(path.join(home, '.claude'));
  return { installed, warnings: [] };
}

export const claudeAdapter: Adapter = {
  name: 'claude',
  supportsPreContextInjection: true,
  supportsPromptSubmitInjection: true,
  supportsSessionStartInjection: true,
  install: installImpl,
  uninstall: uninstallImpl,
  detect: detectImpl,
};

// ── Back-compat re-exports for callers that still import from
// `install-claude-hooks.ts`. These mirror the old surface as closely as
// possible while delegating to the adapter.
export interface LegacyInstallOptions {
  scope: 'user' | 'project';
  tool: 'claude' | 'codex' | 'copilot' | 'gemini' | 'all';
  exclusive?: boolean;
  skipIfClaudeMem?: boolean;
  homeDir?: string;
  cwd?: string;
  hookCommand?: string;
}

export interface LegacyInstallResult {
  settingsPath: string;
  sidecarPath: string;
  addedHooks: string[];
  coexistedWithClaudeMem: boolean;
  skipped?: string;
  backupPath?: string;
}

export function installClaudeHooks(options: LegacyInstallOptions): LegacyInstallResult {
  const home = options.homeDir ?? '';
  const cwd = options.cwd ?? '';
  const result = installImpl({
    scope: options.scope,
    home,
    cwd,
    hookCommand: options.hookCommand,
    skipIfClaudeMem: options.skipIfClaudeMem,
    exclusive: options.exclusive,
  });
  const sidecarPath = result.auxFiles.find((p) => p.endsWith('settings.brain-hooks.json')) ?? '';
  return {
    settingsPath: result.configPath,
    sidecarPath,
    addedHooks: result.addedEvents,
    coexistedWithClaudeMem: result.warnings.some((w) => w.toLowerCase().includes('claude-mem')),
    skipped: result.skipped,
    backupPath: result.backupPath,
  };
}

export function uninstallClaudeHooks(
  options: Pick<LegacyInstallOptions, 'scope' | 'homeDir' | 'cwd'>,
): { removed: string[]; settingsPath: string } {
  const result = uninstallImpl({
    scope: options.scope,
    home: options.homeDir ?? '',
    cwd: options.cwd ?? '',
  });
  return { removed: result.removed, settingsPath: result.configPath };
}
