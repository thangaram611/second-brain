import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type HookScope = 'user' | 'project';
export type HookTool = 'claude' | 'codex' | 'copilot' | 'gemini' | 'all';

export interface InstallHooksOptions {
  scope: HookScope;
  tool: HookTool;
  /** If true, remove claude-mem hook entries first (backing them up). */
  exclusive?: boolean;
  /** If true, abort when claude-mem is present rather than coexisting. */
  skipIfClaudeMem?: boolean;
  /** Override home dir for testing. */
  homeDir?: string;
  /** Override project cwd for testing. */
  cwd?: string;
  /** Override brain-hook command (for relocatable installs). */
  hookCommand?: string;
}

export interface InstallHooksResult {
  settingsPath: string;
  sidecarPath: string;
  addedHooks: string[];
  coexistedWithClaudeMem: boolean;
  skipped?: string;
  backupPath?: string;
}

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

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
  entries: Array<{ event: ClaudeHookEvent; command: string }>;
}

function brainHookCommand(event: ClaudeHookEvent, override?: string): string {
  const bin = override ?? 'brain-hook';
  switch (event) {
    case 'SessionStart':
      return `${bin} session-start`;
    case 'UserPromptSubmit':
      return `${bin} prompt-submit`;
    case 'PreToolUse':
      return `${bin} tool-use --phase pre`;
    case 'PostToolUse':
      return `${bin} tool-use --phase post`;
    case 'Stop':
      return `${bin} stop`;
    case 'SessionEnd':
      return `${bin} session-end`;
  }
}

function resolveSettingsPath(scope: HookScope, home: string, cwd: string): string {
  if (scope === 'user') return path.join(home, '.claude', 'settings.json');
  return path.join(cwd, '.claude', 'settings.json');
}

function resolveSidecarPath(settingsPath: string): string {
  const dir = path.dirname(settingsPath);
  return path.join(dir, 'settings.brain-hooks.json');
}

function loadJson<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups) continue;
    const cleaned: ClaudeHookGroup[] = [];
    for (const g of groups) {
      const keep = (g.hooks ?? []).filter((h) => !isClaudeMemCommand(h.command));
      if (keep.length > 0) cleaned.push({ ...g, hooks: keep });
    }
    if (cleaned.length > 0) {
      (next.hooks as Record<string, ClaudeHookGroup[]>)[event] = cleaned;
    }
  }
  return next;
}

function upsertHook(
  settings: ClaudeSettings,
  event: ClaudeHookEvent,
  command: string,
): boolean {
  settings.hooks = settings.hooks ?? {};
  const groups = (settings.hooks[event] ?? []) as ClaudeHookGroup[];
  const alreadyPresent = groups.some((g) =>
    (g.hooks ?? []).some((h) => h.command === command),
  );
  if (alreadyPresent) return false;

  const useMatcher = event === 'PreToolUse' || event === 'PostToolUse';
  groups.push(useMatcher ? { matcher: '.*', hooks: [{ type: 'command', command }] } : { hooks: [{ type: 'command', command }] });
  settings.hooks[event] = groups;
  return true;
}

function removeHook(settings: ClaudeSettings, command: string): boolean {
  const hooks = settings.hooks;
  if (!hooks) return false;
  let removed = false;
  for (const event of Object.keys(hooks) as ClaudeHookEvent[]) {
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

export function installClaudeHooks(options: InstallHooksOptions): InstallHooksResult {
  const home = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const settingsPath = resolveSettingsPath(options.scope, home, cwd);
  const sidecarPath = resolveSidecarPath(settingsPath);

  let settings = loadJson<ClaudeSettings>(settingsPath, {});
  const hasClaudeMem = detectClaudeMem(settings);
  if (hasClaudeMem && options.skipIfClaudeMem) {
    return {
      settingsPath,
      sidecarPath,
      addedHooks: [],
      coexistedWithClaudeMem: true,
      skipped: 'claude-mem hooks present and --skip-if-claude-mem was set',
    };
  }

  let backupPath: string | undefined;
  if (hasClaudeMem && options.exclusive) {
    backupPath = path.join(path.dirname(settingsPath), 'settings.brain-hooks.backup.json');
    writeJson(backupPath, settings);
    settings = stripClaudeMem(settings);
  }

  const added: string[] = [];
  const entries: Array<{ event: ClaudeHookEvent; command: string }> = [];
  for (const event of CLAUDE_HOOK_EVENTS) {
    const cmd = brainHookCommand(event, options.hookCommand);
    if (upsertHook(settings, event, cmd)) added.push(event);
    entries.push({ event, command: cmd });
  }

  writeJson(settingsPath, settings);

  const sidecar: Sidecar = {
    version: 1,
    installedAt: new Date().toISOString(),
    entries,
  };
  writeJson(sidecarPath, sidecar);

  return {
    settingsPath,
    sidecarPath,
    addedHooks: added,
    coexistedWithClaudeMem: hasClaudeMem && !options.exclusive,
    backupPath,
  };
}

export function uninstallClaudeHooks(
  options: Pick<InstallHooksOptions, 'scope' | 'homeDir' | 'cwd'>,
): { removed: string[]; settingsPath: string } {
  const home = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const settingsPath = resolveSettingsPath(options.scope, home, cwd);
  const sidecarPath = resolveSidecarPath(settingsPath);

  const settings = loadJson<ClaudeSettings>(settingsPath, {});
  const sidecar = loadJson<Sidecar | null>(sidecarPath, null);

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
  return { removed, settingsPath };
}
