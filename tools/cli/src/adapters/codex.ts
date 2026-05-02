/**
 * Codex CLI adapter — full capability (Pre/Prompt/Session-start).
 *
 * Per plan §C and verified against developers.openai.com/codex/hooks:
 *   - Same JSON shape as Claude: `~/.codex/hooks.json` (user) or
 *     `<repo>/.codex/hooks.json` (project), event names camelCase.
 *   - Codex requires `[features] codex_hooks = true` in `~/.codex/config.toml`
 *     to enable hooks. The adapter idempotently sets that flag and a
 *     `[mcp_servers.second-brain]` block.
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

const CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
] as const;
type CodexEvent = (typeof CODEX_EVENTS)[number];

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
  const bin = override ?? 'brain-hook';
  const flag = '--adapter codex';
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
  }
}

function resolveHooksPath(scope: 'user' | 'project', home: string, cwd: string): string {
  if (scope === 'user') return path.join(home, '.codex', 'hooks.json');
  return path.join(cwd, '.codex', 'hooks.json');
}

function resolveConfigTomlPath(home: string): string {
  // Codex feature flag + MCP block live in the user-level config.
  return path.join(home, '.codex', 'config.toml');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

interface UpsertSpec {
  event: CodexEvent;
  command: string;
  matcher?: string;
}

function upsert(file: CodexHooksFile, spec: UpsertSpec): boolean {
  const groups: CodexHookGroup[] = file.hooks[spec.event] ?? [];
  let matched = false;
  let updated = false;
  for (const g of groups) {
    for (const h of g.hooks) {
      if (h.command === spec.command) {
        matched = true;
      } else if (h.command.includes(HOOK_SENTINEL)) {
        h.command = spec.command;
        matched = true;
        updated = true;
      }
    }
    if (matched) break;
  }
  if (!matched) {
    groups.push(spec.matcher
      ? { matcher: spec.matcher, hooks: [{ type: 'command', command: spec.command }] }
      : { hooks: [{ type: 'command', command: spec.command }] });
  }
  file.hooks[spec.event] = groups;
  return !matched || updated;
}

/**
 * Idempotent edit of `~/.codex/config.toml`:
 *   - Ensures `[features] codex_hooks = true`.
 *   - Ensures `[mcp_servers.second-brain]` block with `command` + `args`.
 *
 * We do simple line-oriented editing rather than pulling in a TOML parser —
 * the file is small and the structure is well-known.
 */
export function upsertCodexConfigToml(currentContent: string): {
  next: string;
  changed: boolean;
} {
  let content = currentContent;
  let changed = false;

  // ── [features] block ───────────────────────────────────────────────────
  if (!/^\[features\]/m.test(content)) {
    if (content && !content.endsWith('\n')) content += '\n';
    content += '\n[features]\ncodex_hooks = true\n';
    changed = true;
  } else if (!/^\s*codex_hooks\s*=\s*true\b/m.test(content)) {
    // Insert after the [features] header line.
    content = content.replace(/^(\[features\]\s*\n)/m, '$1codex_hooks = true\n');
    changed = true;
  }

  // ── [mcp_servers.second-brain] block ───────────────────────────────────
  if (!/^\[mcp_servers\.second-brain\]/m.test(content)) {
    if (content && !content.endsWith('\n')) content += '\n';
    content += '\n[mcp_servers.second-brain]\ncommand = "brain"\nargs = ["mcp"]\n';
    changed = true;
  }

  return { next: content, changed };
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
  const tomlPath = resolveConfigTomlPath(opts.home);
  let currentToml = '';
  if (fs.existsSync(tomlPath)) {
    try {
      currentToml = fs.readFileSync(tomlPath, 'utf8');
    } catch {
      // ignore
    }
  }
  const { next, changed } = upsertCodexConfigToml(currentToml);
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
      const keep = g.hooks.filter((h) => !h.command.includes(HOOK_SENTINEL));
      if (keep.length !== g.hooks.length) {
        if (!removed.includes(eventStr)) removed.push(eventStr);
      }
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
