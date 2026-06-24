/**
 * Codex CLI adapter — full capability (Pre/Prompt/Session-start).
 *
 * Per plan §C and verified against developers.openai.com/codex/hooks:
 *   - Same JSON shape as Claude: `~/.codex/hooks.json` (user) or
 *     `<repo>/.codex/hooks.json` (project), event names camelCase.
 *   - Codex 0.129+ requires `[features] hooks = true` in `~/.codex/config.toml`
 *     to enable hooks (renamed from the deprecated `codex_hooks`). The adapter
 *     idempotently sets that flag and a `[mcp_servers.second-brain]` block
 *     wrapped in managed-region markers.
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
import { resolveBrainMcpInvocation, type BrainMcpInvocation } from './mcp-resolve.js';
import { isRecord, writeJson } from './shared/json-file.js';
import { brainHookCommand as renderHookCommand, type HookVerb, type Phase } from './shared/hook-events.js';
import { upsertSentinelDedup, removeSentinelEntries } from './shared/sentinel.js';

const CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
] as const;
type CodexEvent = (typeof CODEX_EVENTS)[number];

/** Host event → brain verb+phase mapping for Codex CLI. */
const CODEX_EVENT_MAP: Record<CodexEvent, { verb: HookVerb; phase?: Phase }> = {
  SessionStart: { verb: 'session-start' },
  UserPromptSubmit: { verb: 'prompt-submit' },
  PreToolUse: { verb: 'tool-use', phase: 'pre' },
  PostToolUse: { verb: 'tool-use', phase: 'post' },
  Stop: { verb: 'stop' },
};

interface CodexHookCommand {
  type: 'command';
  command: string;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookCommand[];
}

interface CodexHooksFile {
  version: 1;
  hooks: Partial<Record<CodexEvent, CodexHookGroup[]>>;
}

function brainHookCommand(event: CodexEvent, override?: string): string {
  const { verb, phase } = CODEX_EVENT_MAP[event];
  return renderHookCommand({ verb, phase, adapter: 'codex', bin: override });
}

function resolveHooksPath(scope: 'user' | 'project', home: string, cwd: string): string {
  if (scope === 'user') return path.join(home, '.codex', 'hooks.json');
  return path.join(cwd, '.codex', 'hooks.json');
}

function resolveConfigTomlPath(home: string): string {
  return path.join(home, '.codex', 'config.toml');
}

function isCodexEvent(s: string): s is CodexEvent {
  for (const e of CODEX_EVENTS) if (e === s) return true;
  return false;
}

function loadHooksFile(p: string): CodexHooksFile {
  const fallback: CodexHooksFile = { version: 1, hooks: {} };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const hooks: Partial<Record<CodexEvent, CodexHookGroup[]>> = {};
    const rawHooks = parsed.hooks;
    if (isRecord(rawHooks)) {
      for (const [k, v] of Object.entries(rawHooks)) {
        if (!isCodexEvent(k)) continue;
        if (!Array.isArray(v)) continue;
        const groups: CodexHookGroup[] = [];
        for (const g of v) {
          if (!isRecord(g)) continue;
          const matcher = g.matcher;
          const hookList = g.hooks;
          if (!Array.isArray(hookList)) continue;
          const cmds: CodexHookCommand[] = [];
          for (const h of hookList) {
            if (!isRecord(h)) continue;
            const cmd = h.command;
            if (typeof cmd === 'string') cmds.push({ type: 'command', command: cmd });
          }
          if (cmds.length > 0) {
            groups.push(typeof matcher === 'string'
              ? { matcher, hooks: cmds }
              : { hooks: cmds });
          }
        }
        if (groups.length > 0) hooks[k] = groups;
      }
    }
    return { version: 1, hooks };
  } catch {
    return fallback;
  }
}

interface UpsertSpec {
  event: CodexEvent;
  command: string;
  matcher?: string;
}

function upsert(file: CodexHooksFile, spec: UpsertSpec): boolean {
  const groups: CodexHookGroup[] = file.hooks[spec.event] ?? [];
  // Sentinel dedup over the flattened group hooks. The command objects are
  // shared references, so an in-place sentinel rewrite propagates back to the
  // groups; the helper's append (onto the flat copy) is discarded and a fresh
  // matcher-bearing group is pushed instead.
  const flat = groups.flatMap((g) => g.hooks);
  const before = flat.length;
  const { changed } = upsertSentinelDedup(
    flat,
    spec.command,
    (cmd) => ({ type: 'command', command: cmd }),
  );
  if (flat.length > before) {
    groups.push(spec.matcher
      ? { matcher: spec.matcher, hooks: [{ type: 'command', command: spec.command }] }
      : { hooks: [{ type: 'command', command: spec.command }] });
  }
  file.hooks[spec.event] = groups;
  return changed;
}

// ─── config.toml editing ────────────────────────────────────────────────────

const MANAGED_BEGIN =
  '# >>> second-brain-mcp managed block — do not edit between markers; comment out the block to disable';
const MANAGED_END = '# <<< second-brain-mcp managed block';

function renderManagedBlock(inv: BrainMcpInvocation): string {
  const lines: string[] = [
    MANAGED_BEGIN,
    '[mcp_servers.second-brain]',
    `command = ${JSON.stringify(inv.command)}`,
    `args = ${JSON.stringify(inv.args)}`,
  ];
  if (inv.env) {
    lines.push('');
    lines.push('[mcp_servers.second-brain.env]');
    for (const [k, v] of Object.entries(inv.env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

function findManagedRegion(content: string): { startIdx: number; endIdx: number } | null {
  const startIdx = content.indexOf(MANAGED_BEGIN);
  if (startIdx === -1) return null;
  const endMarkerIdx = content.indexOf(MANAGED_END, startIdx + MANAGED_BEGIN.length);
  if (endMarkerIdx === -1) return null;
  return { startIdx, endIdx: endMarkerIdx + MANAGED_END.length };
}

function stripLegacyMcpBlocks(content: string): { next: string; removed: boolean } {
  const lines = content.split('\n');
  const out: string[] = [];
  let skipping = false;
  let removed = false;
  for (const line of lines) {
    if (line.startsWith('[mcp_servers.second-brain')) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping) {
      if (line.startsWith('[') && !line.startsWith('[mcp_servers.second-brain')) {
        skipping = false;
      } else {
        // Skip body lines (key = value, blank, comments inside the block).
        continue;
      }
    }
    out.push(line);
  }
  // Collapse 3+ consecutive newlines (left over from removed blocks).
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { next, removed };
}

function upsertFeaturesBlock(content: string): { next: string; changed: boolean } {
  let next = content;
  let changed = false;

  // Migrate deprecated `codex_hooks = true` → drop the line (we'll add `hooks = true` below if needed).
  // Leave `codex_hooks = false` alone (user-explicit opt-out — respect it).
  const codexHooksTrue = /^[ \t]*codex_hooks[ \t]*=[ \t]*true[ \t]*\n?/m;
  if (codexHooksTrue.test(next)) {
    next = next.replace(codexHooksTrue, '');
    changed = true;
  }

  if (!/^\[features\]/m.test(next)) {
    if (next && !next.endsWith('\n')) next += '\n';
    next += '\n[features]\nhooks = true\n';
    changed = true;
  } else if (!/^[ \t]*hooks[ \t]*=[ \t]*true\b/m.test(next)) {
    next = next.replace(/^(\[features\][ \t]*\n)/m, '$1hooks = true\n');
    changed = true;
  }

  return { next, changed };
}

function isManagedBlockCommentedOut(content: string, region: { startIdx: number; endIdx: number }): boolean {
  const inner = content.slice(region.startIdx + MANAGED_BEGIN.length, region.endIdx - MANAGED_END.length);
  const meaningfulLines = inner.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (meaningfulLines.length === 0) return false;
  return meaningfulLines.every((l) => l.startsWith('#'));
}

/**
 * Idempotent edit of `~/.codex/config.toml`:
 *   - Ensures `[features] hooks = true`, migrating away from deprecated `codex_hooks`.
 *   - Manages the `[mcp_servers.second-brain]` block inside a bracketed marker pair.
 *
 * Upsert state machine for the MCP region:
 *   1. Managed region present, body NOT commented out → replace with fresh content
 *      (no-op if invocation matches; updates if `command`/`args`/`env` differ).
 *   2. Managed region present, body all `#`-commented → respect user intent;
 *      do not rewrite. Caller receives a `warning` describing the state.
 *   3. No managed region, legacy `[mcp_servers.second-brain]` block exists →
 *      strip the legacy block and append a fresh managed region.
 *   4. No managed region, no legacy block → append a fresh managed region.
 *   5. Invocation is null (helper failed) → strip any managed/legacy block so
 *      Codex doesn't try to spawn a stale/broken entry. Hooks still install.
 */
export function upsertCodexConfigToml(
  currentContent: string,
  invocation: BrainMcpInvocation | null,
): { next: string; changed: boolean; warning?: string } {
  // 1) Features-block normalization (independent of invocation).
  const features = upsertFeaturesBlock(currentContent);
  let working = features.next;
  let changed = features.changed;

  // 2) MCP region.
  const region = findManagedRegion(working);

  if (region) {
    if (isManagedBlockCommentedOut(working, region)) {
      // State 2 — respect user disable.
      return {
        next: working,
        changed,
        warning:
          'second-brain MCP block in ~/.codex/config.toml is commented out under the managed markers; ' +
          'leaving it disabled. Remove the markers (or uncomment the block) to re-enable.',
      };
    }
    if (!invocation) {
      // State 5 — strip the managed region so Codex stops trying to spawn it.
      const before = working.slice(0, region.startIdx);
      const after = working.slice(region.endIdx);
      let removed = before + after;
      removed = removed.replace(/\n{3,}/g, '\n\n');
      if (removed.endsWith('\n\n')) removed = removed.slice(0, -1);
      return { next: removed, changed: true };
    }
    // State 1 — replace block.
    const replacement = renderManagedBlock(invocation);
    const before = working.slice(0, region.startIdx);
    const after = working.slice(region.endIdx);
    const nextContent = before + replacement + after;
    return { next: nextContent, changed: changed || nextContent !== working };
  }

  // No managed region; strip any legacy unmanaged block first.
  const strip = stripLegacyMcpBlocks(working);
  if (strip.removed) {
    working = strip.next;
    changed = true;
  }

  if (!invocation) {
    // State 5 (no managed, possibly removed legacy) — done.
    return { next: working, changed };
  }

  // State 3 or 4 — append fresh managed region.
  const replacement = renderManagedBlock(invocation);
  if (working && !working.endsWith('\n')) working += '\n';
  if (!working.endsWith('\n\n')) working += '\n';
  working += replacement + '\n';
  return { next: working, changed: true };
}

function installImpl(opts: AdapterInstallOptions): AdapterInstallResult {
  const hooksPath = resolveHooksPath(opts.scope, opts.home, opts.cwd);
  const file = loadHooksFile(hooksPath);
  const added: string[] = [];
  const auxFiles: string[] = [];
  const warnings: string[] = [];

  const specs: UpsertSpec[] = [
    { event: 'SessionStart', command: brainHookCommand('SessionStart', opts.hookCommand) },
    { event: 'UserPromptSubmit', command: brainHookCommand('UserPromptSubmit', opts.hookCommand) },
    {
      event: 'PreToolUse',
      command: brainHookCommand('PreToolUse', opts.hookCommand),
      matcher: '.*',
    },
    {
      event: 'PostToolUse',
      command: brainHookCommand('PostToolUse', opts.hookCommand),
      matcher: '.*',
    },
    { event: 'Stop', command: brainHookCommand('Stop', opts.hookCommand) },
  ];

  for (const spec of specs) {
    if (upsert(file, spec)) added.push(spec.event);
  }
  writeJson(hooksPath, file);

  // ── Update ~/.codex/config.toml ──────────────────────────────────────
  const resolved = resolveBrainMcpInvocation();
  if (resolved.warning) warnings.push(resolved.warning);

  const tomlPath = resolveConfigTomlPath(opts.home);
  let currentToml = '';
  if (fs.existsSync(tomlPath)) {
    try {
      currentToml = fs.readFileSync(tomlPath, 'utf8');
    } catch {
      // ignore
    }
  }
  const { next, changed, warning } = upsertCodexConfigToml(currentToml, resolved.invocation);
  if (warning) warnings.push(warning);
  if (changed) {
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, next, 'utf8');
    auxFiles.push(tomlPath);
  }

  return {
    configPath: hooksPath,
    addedEvents: added,
    auxFiles,
    warnings,
  };
}

function uninstallImpl(opts: AdapterUninstallOptions): AdapterUninstallResult {
  const hooksPath = resolveHooksPath(opts.scope, opts.home, opts.cwd);
  const removed: string[] = [];
  if (!fs.existsSync(hooksPath)) {
    return { configPath: hooksPath, removed, warnings: [] };
  }
  const file = loadHooksFile(hooksPath);
  for (const eventStr of Object.keys(file.hooks)) {
    if (!isCodexEvent(eventStr)) continue;
    const groups = file.hooks[eventStr];
    if (!groups) continue;
    const cleaned: CodexHookGroup[] = [];
    for (const g of groups) {
      const { list: keep, removed: didRemove } = removeSentinelEntries(g.hooks);
      if (didRemove && !removed.includes(eventStr)) removed.push(eventStr);
      if (keep.length > 0) cleaned.push({ ...g, hooks: keep });
    }
    if (cleaned.length > 0) file.hooks[eventStr] = cleaned;
    else delete file.hooks[eventStr];
  }
  writeJson(hooksPath, file);
  return { configPath: hooksPath, removed, warnings: [] };
}

function detectImpl(home: string, _cwd: string): AdapterDetectResult {
  const installed = fs.existsSync(path.join(home, '.codex'));
  return { installed, warnings: [] };
}

export const codexAdapter: Adapter = {
  name: 'codex',
  supportsPreContextInjection: true,
  supportsPromptSubmitInjection: true,
  supportsSessionStartInjection: true,
  install: installImpl,
  uninstall: uninstallImpl,
  detect: detectImpl,
};
