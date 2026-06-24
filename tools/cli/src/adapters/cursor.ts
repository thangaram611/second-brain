/**
 * Cursor adapter — partial capability (sessionStart inject + .mdc rules file).
 *
 * Per plan §C and verified against cursor.com/docs/hooks:
 *   - `<repo>/.cursor/hooks.json` with events sessionStart / beforeReadFile /
 *     beforeShellExecution / postToolUse / afterFileEdit / stop.
 *   - Default scope is `project` (matches the team-manifest model).
 *   - The dependable injection path is `.cursor/rules/*.mdc` (note: `.mdc`
 *     extension, NOT `.md`). The hook regenerates the rules file on every
 *     `sessionStart`/`stop`.
 *   - `postToolUse` `additional_context` injection is gated behind
 *     `BRAIN_CURSOR_POSTTOOL_INJECT=1` (default off — observe-only). This
 *     adapter still installs the hook entry; the binary suppresses the
 *     injection envelope unless the flag is set.
 *   - MCP config goes to `<repo>/.cursor/mcp.json` (separate writer).
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
import { resolveBrainMcpInvocation } from './mcp-resolve.js';
import { isRecord, writeJson } from './shared/json-file.js';
import { brainHookCommand as renderHookCommand, type HookVerb, type Phase } from './shared/hook-events.js';
import { upsertSentinelDedup, removeSentinelEntries } from './shared/sentinel.js';
import { upsertMcpServersJson } from './shared/mcp-merge.js';

interface CursorHookCommand {
  command: string;
}

interface CursorHooksFile {
  version: 1;
  hooks: Record<string, CursorHookCommand[]>;
}

const CURSOR_EVENTS = [
  'sessionStart',
  'beforeReadFile',
  'beforeShellExecution',
  'postToolUse',
  'afterFileEdit',
  'stop',
] as const;
type CursorEvent = (typeof CURSOR_EVENTS)[number];

/**
 * Host event → brain verb+phase mapping for Cursor. Note the deliberate
 * host-specific differences: `postToolUse` uses the `post-inject` phase (the
 * gated injection path), and `stop` maps to `session-end`.
 */
const CURSOR_EVENT_MAP: Record<CursorEvent, { verb: HookVerb; phase?: Phase }> = {
  sessionStart: { verb: 'session-start' },
  beforeReadFile: { verb: 'tool-use', phase: 'pre' },
  beforeShellExecution: { verb: 'tool-use', phase: 'pre' },
  postToolUse: { verb: 'tool-use', phase: 'post-inject' },
  afterFileEdit: { verb: 'tool-use', phase: 'post' },
  stop: { verb: 'session-end' },
};

function brainHookCommand(event: CursorEvent, override?: string): string {
  const { verb, phase } = CURSOR_EVENT_MAP[event];
  return renderHookCommand({ verb, phase, adapter: 'cursor', bin: override });
}

function resolveHooksPath(scope: 'user' | 'project', home: string, cwd: string): string {
  if (scope === 'user') return path.join(home, '.cursor', 'hooks.json');
  return path.join(cwd, '.cursor', 'hooks.json');
}

function resolveRulesPath(cwd: string): string {
  return path.join(cwd, '.cursor', 'rules', 'second-brain-context.mdc');
}

function resolveMcpPath(cwd: string): string {
  return path.join(cwd, '.cursor', 'mcp.json');
}

function loadHooksFile(p: string): CursorHooksFile | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const hooks = parsed.hooks;
    const out: CursorHooksFile = { version: 1, hooks: {} };
    if (isRecord(hooks)) {
      for (const [k, v] of Object.entries(hooks)) {
        if (!Array.isArray(v)) continue;
        const cmds: CursorHookCommand[] = [];
        for (const c of v) {
          if (isRecord(c) && typeof c.command === 'string') {
            cmds.push({ command: c.command });
          }
        }
        out.hooks[k] = cmds;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function defaultRulesContent(): string {
  // Placeholder content — at runtime the hook re-generates this on
  // sessionStart with the live WIP/decisions snapshot.
  return [
    '---',
    'description: Second Brain context (auto-generated)',
    'globs:',
    'alwaysApply: true',
    '---',
    '',
    '<!-- This file is regenerated on every Cursor sessionStart by brain-hook. -->',
    '<!-- Do not edit manually; edits will be overwritten. -->',
    '',
    '## Recent decisions, WIP and patterns',
    '',
    '_(none yet — start a Cursor session to populate this file.)_',
    '',
  ].join('\n');
}

function installImpl(opts: AdapterInstallOptions): AdapterInstallResult {
  const hooksPath = resolveHooksPath(opts.scope, opts.home, opts.cwd);
  const rulesPath = resolveRulesPath(opts.cwd);
  const mcpPath = resolveMcpPath(opts.cwd);
  const warnings: string[] = [];
  const auxFiles: string[] = [];

  // ── 1. hooks.json ──────────────────────────────────────────────────────
  const existing = loadHooksFile(hooksPath) ?? { version: 1, hooks: {} };
  const added: string[] = [];
  for (const event of CURSOR_EVENTS) {
    const cmd = brainHookCommand(event, opts.hookCommand);
    const list = existing.hooks[event] ?? [];
    const { changed } = upsertSentinelDedup(list, cmd, (command) => ({ command }));
    if (changed) added.push(event);
    existing.hooks[event] = list;
  }
  writeJson(hooksPath, existing);

  // ── 2. rules .mdc — write only if absent (initial seed) ────────────────
  if (opts.scope === 'project' || !fs.existsSync(rulesPath)) {
    if (!fs.existsSync(rulesPath)) {
      fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
      fs.writeFileSync(rulesPath, defaultRulesContent(), 'utf8');
    }
    auxFiles.push(rulesPath);
  }

  // ── 3. mcp.json — idempotent merge ─────────────────────────────────────
  const resolved = resolveBrainMcpInvocation();
  if (resolved.warning) warnings.push(resolved.warning);
  if (resolved.invocation) {
    const { written } = upsertMcpServersJson(mcpPath, resolved.invocation);
    if (written) auxFiles.push(mcpPath);
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
  const warnings: string[] = [];
  const existing = loadHooksFile(hooksPath);
  if (!existing) return { configPath: hooksPath, removed, warnings };
  for (const [event, cmds] of Object.entries(existing.hooks)) {
    const { list: filtered, removed: didRemove } = removeSentinelEntries(cmds);
    if (didRemove) removed.push(event);
    if (filtered.length > 0) existing.hooks[event] = filtered;
    else delete existing.hooks[event];
  }
  writeJson(hooksPath, existing);
  return { configPath: hooksPath, removed, warnings };
}

function detectImpl(home: string, cwd: string): AdapterDetectResult {
  const projectDir = path.join(cwd, '.cursor');
  const userDir = path.join(home, '.cursor');
  const installed = fs.existsSync(projectDir) || fs.existsSync(userDir);
  return { installed, warnings: [] };
}

export const cursorAdapter: Adapter = {
  name: 'cursor',
  // postToolUse field is accepted but not always injected (see plan).
  // We expose `false` for pre-context-injection to set realistic
  // capability expectations; rules-file is the dependable path.
  supportsPreContextInjection: false,
  supportsPromptSubmitInjection: false,
  supportsSessionStartInjection: true,
  install: installImpl,
  uninstall: uninstallImpl,
  detect: detectImpl,
};
