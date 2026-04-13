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

// ──────────────────────────────────────────────────────────────────────────
// Git hook installer — post-commit, post-merge, post-checkout shims that
// curl the observe/git-event endpoint. Sidecar-tracked so unwire can
// restore any pre-existing user hook scripts.
// ──────────────────────────────────────────────────────────────────────────

export const GIT_HOOK_NAMES = ['post-commit', 'post-merge', 'post-checkout'] as const;
export type GitHookName = (typeof GIT_HOOK_NAMES)[number];

interface GitHookSidecar {
  version: 1;
  installedAt: string;
  entries: Array<{ name: GitHookName; backupPath?: string }>;
}

export interface InstallGitHooksOptions {
  /** Absolute repo root. The hooks land in <repoRoot>/.git/hooks/. */
  repoRoot: string;
  /** Server URL the hooks POST to. */
  serverUrl: string;
  /** Bearer token (optional — env override at runtime). */
  bearerToken?: string;
  /** Namespace to stamp on observations. */
  namespace: string;
  /** Override `brain` binary name/path in the hook body. */
  brainBinary?: string;
}

export interface InstallGitHooksResult {
  installed: GitHookName[];
  backups: Array<{ name: GitHookName; path: string }>;
  sidecarPath: string;
}

function gitHookBody(
  name: GitHookName,
  serverUrl: string,
  namespace: string,
): string {
  // Shell script that POSTs the git event. Kept tiny and dependency-free so
  // it works on any dev machine; the heavy lifting is server-side.
  const kind = name === 'post-commit' ? 'commit' : name === 'post-merge' ? 'merge' : 'checkout';
  return [
    '#!/bin/sh',
    '# Installed by second-brain `brain wire`. Safe to keep alongside other',
    '# tools — this hook only POSTs to a local endpoint and never fails the',
    '# git operation.',
    'set -e',
    '',
    `KIND=${kind}`,
    `NAMESPACE=${JSON.stringify(namespace)}`,
    `SERVER_URL="${serverUrl}"`,
    'REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    'BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"',
    'HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"',
    'EMAIL="$(git config --get user.email 2>/dev/null || echo)"',
    'NAME="$(git config --get user.name 2>/dev/null || echo)"',
    'MESSAGE=""',
    'if [ "$KIND" = "commit" ]; then',
    '  MESSAGE="$(git log -1 --pretty=%B 2>/dev/null | head -c 2000 || echo)"',
    'fi',
    '',
    '# Build JSON body without jq (assume simple inputs; escape minimally).',
    'escape() { printf "%s" "$1" | sed -e \'s/\\\\/\\\\\\\\/g\' -e \'s/"/\\\\"/g\' -e \'s/\\n/\\\\n/g\' -e \'s/\\r/\\\\r/g\' -e \'s/\\t/\\\\t/g\'; }',
    '',
    'BODY=$(cat <<JSON',
    '{',
    '  "repo": "$(escape "$REPO")",',
    '  "namespace": "$NAMESPACE",',
    '  "kind": "$KIND",',
    '  "branch": "$(escape "$BRANCH")",',
    '  "headSha": "$(escape "$HEAD_SHA")",',
    '  "message": "$(escape "$MESSAGE")",',
    '  "author": { "canonicalEmail": "$(escape "$EMAIL")", "displayName": "$(escape "$NAME")", "aliases": [] },',
    '  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    '}',
    'JSON',
    ')',
    '',
    'AUTH_HEADER=""',
    '[ -n "${SECOND_BRAIN_TOKEN:-}" ] && AUTH_HEADER="-H Authorization: Bearer ${SECOND_BRAIN_TOKEN}"',
    '',
    'curl -s -m 2 -X POST "$SERVER_URL/api/observe/git-event" \\',
    '  -H "content-type: application/json" \\',
    '  $AUTH_HEADER \\',
    '  -d "$BODY" >/dev/null 2>&1 || true',
    '',
    'exit 0',
    '',
  ].join('\n');
}

function gitHooksDir(repoRoot: string): string {
  // Worktree support: the real hooks dir may live under .git/worktrees/<name>
  // but git still picks them up from there via `core.hooksPath` or by the
  // gitdir-file indirection. For the MVP we drop into <repoRoot>/.git/hooks
  // when `.git` is a directory; if it's a worktree file, fall back to
  // reading the gitdir pointer (synchronous).
  const dotGit = path.join(repoRoot, '.git');
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
  if (!stat) throw new Error(`not a git repo: ${repoRoot}`);
  if (stat.isDirectory()) return path.join(dotGit, 'hooks');
  const content = fs.readFileSync(dotGit, 'utf8');
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) throw new Error(`malformed .git file at ${dotGit}`);
  return path.join(path.resolve(repoRoot, match[1].trim()), 'hooks');
}

function gitHookSidecarPath(repoRoot: string): string {
  return path.join(repoRoot, '.second-brain', 'git-hooks-sidecar.json');
}

export function installGitHooks(options: InstallGitHooksOptions): InstallGitHooksResult {
  const hooksDir = gitHooksDir(options.repoRoot);
  fs.mkdirSync(hooksDir, { recursive: true });
  const sidecarPath = gitHookSidecarPath(options.repoRoot);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  const installed: GitHookName[] = [];
  const backups: Array<{ name: GitHookName; path: string }> = [];
  const entries: GitHookSidecar['entries'] = [];

  for (const name of GIT_HOOK_NAMES) {
    const hookPath = path.join(hooksDir, name);
    const body = gitHookBody(name, options.serverUrl, options.namespace);

    // If a hook already exists and isn't ours, preserve it.
    let backupPath: string | undefined;
    const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : null;
    if (existing && !existing.includes('Installed by second-brain `brain wire`')) {
      backupPath = `${hookPath}.brain-pre-wire.bak`;
      fs.writeFileSync(backupPath, existing, 'utf8');
      backups.push({ name, path: backupPath });
    }
    fs.writeFileSync(hookPath, body, { mode: 0o755 });
    installed.push(name);
    entries.push({ name, backupPath });
  }

  const sidecar: GitHookSidecar = {
    version: 1,
    installedAt: new Date().toISOString(),
    entries,
  };
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');

  return { installed, backups, sidecarPath };
}

export interface UninstallGitHooksResult {
  removed: GitHookName[];
  restored: GitHookName[];
}

export function uninstallGitHooks(repoRoot: string): UninstallGitHooksResult {
  const hooksDir = gitHooksDir(repoRoot);
  const sidecarPath = gitHookSidecarPath(repoRoot);
  const sidecar = loadJson<GitHookSidecar | null>(sidecarPath, null);
  const removed: GitHookName[] = [];
  const restored: GitHookName[] = [];

  if (!sidecar) {
    // No sidecar — remove any of our hooks if present by fingerprint.
    for (const name of GIT_HOOK_NAMES) {
      const hookPath = path.join(hooksDir, name);
      if (!fs.existsSync(hookPath)) continue;
      const content = fs.readFileSync(hookPath, 'utf8');
      if (content.includes('Installed by second-brain `brain wire`')) {
        fs.unlinkSync(hookPath);
        removed.push(name);
      }
    }
    return { removed, restored };
  }

  for (const entry of sidecar.entries) {
    const hookPath = path.join(hooksDir, entry.name);
    if (!fs.existsSync(hookPath)) continue;
    const content = fs.readFileSync(hookPath, 'utf8');
    if (!content.includes('Installed by second-brain `brain wire`')) continue;
    fs.unlinkSync(hookPath);
    removed.push(entry.name);
    if (entry.backupPath && fs.existsSync(entry.backupPath)) {
      fs.renameSync(entry.backupPath, hookPath);
      restored.push(entry.name);
    }
  }
  try {
    fs.unlinkSync(sidecarPath);
  } catch {
    // ignore
  }
  return { removed, restored };
}
