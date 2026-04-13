import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { canonicalizeEmail } from '@second-brain/types';

const ProjectConfigSchema = z.object({ namespace: z.string().min(1).optional() }).passthrough();
import {
  installClaudeHooks,
  installGitHooks,
  type InstallGitHooksResult,
  type InstallHooksResult,
} from './install-hooks.js';
import {
  computeRepoHash,
  loadWiredRepos,
  saveWiredRepos,
  type WiredReposEntry,
} from './git-context-daemon.js';

export interface WireOptions {
  /** Repo root. Defaults to `git rev-parse --show-toplevel` from cwd. */
  repo?: string;
  /** Namespace to write observations into. Falls back to project name from `.second-brain/config.json`; defaults to 'personal' with a warning. */
  namespace?: string;
  /** Server URL the hooks + daemon POST to. */
  serverUrl?: string;
  /** Bearer token. */
  bearerToken?: string;
  /** Hard-fail if no project namespace is resolved (for CI). */
  requireProject?: boolean;
  /** Also install Claude Code session hooks (user scope). Default true. */
  installClaudeSession?: boolean;
  /** Skip if claude-mem already present. */
  skipIfClaudeMem?: boolean;
  /** Override `brain-hook` binary name. */
  hookCommand?: string;
}

export interface WireResult {
  repoRoot: string;
  repoHash: string;
  namespace: string;
  authorEmail: string | null;
  authorName: string | null;
  warnings: string[];
  claudeHooks?: InstallHooksResult;
  gitHooks: InstallGitHooksResult;
  configPath: string;
  watchCommand: string;
}

function resolveRepoRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      cwd: process.cwd(),
      timeout: 2000,
    }).trim();
    if (!out) throw new Error('empty git rev-parse output');
    return path.resolve(out);
  } catch {
    throw new Error(`not inside a git repository (cwd=${process.cwd()})`);
  }
}

function resolveAuthorSync(cwd: string): { email: string | null; name: string | null } {
  const readConfig = (key: string): string | null => {
    try {
      const out = execFileSync('git', ['config', '--get', key], {
        cwd,
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  };
  const rawEmail = readConfig('user.email');
  return {
    email: rawEmail ? canonicalizeEmail(rawEmail) : null,
    name: readConfig('user.name'),
  };
}

function resolveProjectNamespace(repoRoot: string): string | null {
  const configPath = path.join(repoRoot, '.second-brain', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = ProjectConfigSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data.namespace ?? null;
  } catch {
    return null;
  }
}

export async function runWire(options: WireOptions = {}): Promise<WireResult> {
  const repoRoot = resolveRepoRoot(options.repo);
  const warnings: string[] = [];

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`not a git repo: ${repoRoot}`);
  }
  const { email, name } = resolveAuthorSync(repoRoot);
  if (!email) {
    warnings.push(
      'git config user.email is not set — observations will not be attributed to you. Run `git config --global user.email you@example.com`.',
    );
  }

  const configuredNs = resolveProjectNamespace(repoRoot);
  let namespace: string;
  if (options.namespace) {
    namespace = options.namespace;
  } else if (configuredNs) {
    namespace = configuredNs;
  } else {
    if (options.requireProject) {
      throw new Error(
        `no project namespace set for ${repoRoot}. Run \`brain init -p <project>\` first, or omit --require-project to wire with namespace='personal'.`,
      );
    }
    warnings.push(
      `this repo has no project namespace — observations will land in 'personal' alongside your identity + patterns, which mixes team-visible repo data with local-only personal data. Run \`brain init -p <project>\` to fix; continuing with namespace='personal'.`,
    );
    namespace = 'personal';
  }

  const serverUrl = options.serverUrl ?? process.env.SECOND_BRAIN_SERVER_URL ?? 'http://localhost:7430';

  const gitHooks = installGitHooks({
    repoRoot,
    serverUrl,
    bearerToken: options.bearerToken,
    namespace,
  });

  let claudeHooks: InstallHooksResult | undefined;
  if (options.installClaudeSession ?? true) {
    claudeHooks = installClaudeHooks({
      scope: 'user',
      tool: 'claude',
      skipIfClaudeMem: options.skipIfClaudeMem,
      hookCommand: options.hookCommand,
    });
  }

  const repoHash = computeRepoHash(repoRoot);
  const wired = loadWiredRepos();
  const entry: WiredReposEntry = {
    repoHash,
    absPath: repoRoot,
    namespace,
    installedAt: new Date().toISOString(),
  };
  wired.wiredRepos[repoHash] = entry;
  saveWiredRepos(wired);

  const configPath = path.join(os.homedir(), '.second-brain', 'config.json');
  const watchCommand = `brain watch --repo ${JSON.stringify(repoRoot)}`;

  return {
    repoRoot,
    repoHash,
    namespace,
    authorEmail: email,
    authorName: name,
    warnings,
    claudeHooks,
    gitHooks,
    configPath,
    watchCommand,
  };
}
