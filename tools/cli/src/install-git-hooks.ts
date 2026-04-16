import * as fs from 'node:fs';
import * as path from 'node:path';

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

/**
 * Single-quote a value for safe embedding in a POSIX shell script as a
 * literal. `foo'bar` → `'foo'\''bar'`. The resulting token is a shell
 * string literal — no variable expansion, no command substitution.
 */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitHookBody(
  name: GitHookName,
  serverUrl: string,
  namespace: string,
): string {
  const kind = name === 'post-commit' ? 'commit' : name === 'post-merge' ? 'merge' : 'checkout';
  const nsLit = shSingleQuote(namespace);
  const urlLit = shSingleQuote(serverUrl);
  return [
    '#!/bin/sh',
    '# Installed by second-brain `brain wire`. Safe to keep alongside other',
    '# tools — this hook only POSTs to a local endpoint and never fails the',
    '# git operation.',
    'set -e',
    '',
    `KIND=${kind}`,
    `NAMESPACE=${nsLit}`,
    `SERVER_URL=${urlLit}`,
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
    '# post-merge: extract the MERGED (source) branch. `git reflog -1 --format=%gs`',
    '# gives a stable "merge <branch>: <strategy>" format for BOTH merge commits',
    '# and fast-forward merges. Empty → server skips flipBranchStatus.',
    'MERGED_BRANCH=""',
    'if [ "$KIND" = "merge" ]; then',
    '  REFLOG_SUBJECT="$(git reflog -1 --format=%gs HEAD 2>/dev/null || echo)"',
    '  case "$REFLOG_SUBJECT" in',
    '    "merge "*)',
    '      REST="${REFLOG_SUBJECT#merge }"',
    '      MERGED_BRANCH="${REST%%:*}"',
    '      ;;',
    '  esac',
    '  MERGED_BRANCH="$(printf %s "$MERGED_BRANCH" | head -c 200)"',
    'fi',
    '',
    '# Build JSON body without jq.',
    "escape() { printf %s \"$1\" | tr -d '\\000-\\037' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g'; }",
    '',
    'BODY=$(cat <<JSON',
    '{',
    '  "repo": "$(escape "$REPO")",',
    '  "namespace": "$(escape "$NAMESPACE")",',
    '  "kind": "$KIND",',
    '  "branch": "$(escape "$BRANCH")",',
    '  "headSha": "$(escape "$HEAD_SHA")",',
    '  "message": "$(escape "$MESSAGE")",',
    '  "mergedBranch": "$(escape "$MERGED_BRANCH")",',
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

function loadJson<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
