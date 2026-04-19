import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import lockfile from 'proper-lockfile';
import { canonicalizeEmail } from '@second-brain/types';
import { GitLabProvider, GitHubProvider, resolveGitLabProject, mintRelayChannel } from '@second-brain/collectors';

const ProjectConfigSchema = z.object({ namespace: z.string().min(1).optional() }).passthrough();
import {
  installClaudeHooks,
  type InstallHooksResult,
} from './install-claude-hooks.js';
import {
  installGitHooks,
  type InstallGitHooksResult,
} from './install-git-hooks.js';
import {
  computeRepoHash,
  loadWiredRepos,
  saveWiredRepos,
  type WiredReposEntry,
} from './git-context-daemon.js';
import { storeSecret } from './keychain.js';

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

  // ── Phase 10.3 — provider setup ────────────────────────────────────────
  /** Forge provider to wire. If omitted, provider setup is skipped. */
  provider?: 'gitlab' | 'github';
  /** GitLab base URL (with or without `/api/v4` suffix). Auto-detected from
      `git remote get-url origin` when omitted. */
  gitlabBaseUrl?: string;
  /** GitLab PAT. If omitted, falls back to `SECOND_BRAIN_GITLAB_TOKEN` env. */
  gitlabToken?: string;
  /** GitLab project path (`group/subgroup/project`). Auto-detected from
      `git remote get-url origin` when omitted. */
  gitlabProjectPath?: string;
  /** Inject a provider instance for tests. */
  gitlabProvider?: GitLabProvider;
  /** Inject a fetch implementation for tests (project-resolve + relay mint). */
  fetchImpl?: typeof fetch;

  // ── GitHub provider options ─────────────────────────────────────────────
  /** GitHub PAT. Falls back to SECOND_BRAIN_GITHUB_TOKEN or GITHUB_TOKEN env. */
  githubToken?: string;
  /** GitHub owner (user or org). Auto-detected from git remote. */
  githubOwner?: string;
  /** GitHub repo name. Auto-detected from git remote. */
  githubRepo?: string;
  /** Inject a GitHubProvider instance for tests. */
  githubProvider?: GitHubProvider;
}

export interface ProviderWireResult {
  provider: 'gitlab' | 'github';
  projectId: string;
  webhookId: number;
  webhookAlreadyExisted: boolean;
  relayUrl: string;
  baseUrl: string;
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
  providerResult?: ProviderWireResult;
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
  // ── Concurrent-wire guard (plan revision #4) ────────────────────────────
  const configDir = path.join(os.homedir(), '.second-brain');
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = path.join(configDir, '.wire.lock');
  // Ensure the lock file exists so `proper-lockfile` can acquire an
  // exclusive lock on it without failing.
  if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, '', 'utf8');
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockPath, {
      realpath: false,
      retries: 0,
      stale: 60_000,
    });
  } catch (err) {
    throw new Error(
      `another wire operation is in progress (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  try {
    return await runWireInternal(options);
  } finally {
    await release();
  }
}

async function runWireInternal(options: WireOptions): Promise<WireResult> {
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
  const baseEntry: WiredReposEntry = {
    repoHash,
    absPath: repoRoot,
    namespace,
    installedAt: new Date().toISOString(),
  };
  wired.wiredRepos[repoHash] = baseEntry;
  saveWiredRepos(wired);

  // ── Phase 10.3 — provider wiring (optional) ──────────────────────────
  let providerResult: ProviderWireResult | undefined;
  if (options.provider === 'gitlab') {
    try {
      providerResult = await wireGitLabProvider(repoRoot, options, warnings);
      if (providerResult) {
        const updated: WiredReposEntry = {
          ...baseEntry,
          providerId: 'gitlab',
          projectId: providerResult.projectId,
          providerBaseUrl: providerResult.baseUrl,
          webhookId: providerResult.webhookId,
          relayUrl: providerResult.relayUrl,
        };
        wired.wiredRepos[repoHash] = updated;
        saveWiredRepos(wired);
      }
    } catch (err) {
      warnings.push(
        `GitLab provider wiring failed: ${err instanceof Error ? err.message : String(err)}. Claude/git hooks are installed; you can retry with \`brain provider refresh gitlab\`.`,
      );
    }
  } else if (options.provider === 'github') {
    try {
      providerResult = await wireGitHubProvider(repoRoot, options, warnings);
      if (providerResult) {
        const updated: WiredReposEntry = {
          ...baseEntry,
          providerId: 'github',
          projectId: providerResult.projectId,
          providerBaseUrl: providerResult.baseUrl,
          githubOwner: providerResult.projectId.split('/')[0],
          githubRepo: providerResult.projectId.split('/')[1],
          webhookId: providerResult.webhookId,
          relayUrl: providerResult.relayUrl,
        };
        wired.wiredRepos[repoHash] = updated;
        saveWiredRepos(wired);
      }
    } catch (err) {
      warnings.push(
        `GitHub provider wiring failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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
    providerResult,
  };
}

function readGitRemoteOrigin(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Extract `(host, projectPath)` from a git remote URL.
 *   SSH  — git@host:group/subgroup/project.git → {host, path: 'group/subgroup/project'}
 *   HTTPS — https://host/group/subgroup/project.git → same
 */
export function parseGitRemote(remote: string): { host: string; projectPath: string } | null {
  const sshMatch = remote.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], projectPath: sshMatch[2] };
  }
  const httpsMatch = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { host: httpsMatch[1], projectPath: httpsMatch[2] };
  }
  return null;
}

async function wireGitLabProvider(
  repoRoot: string,
  options: WireOptions,
  warnings: string[],
): Promise<ProviderWireResult | undefined> {
  const remote = readGitRemoteOrigin(repoRoot);
  const parsed = remote ? parseGitRemote(remote) : null;

  const projectPath =
    options.gitlabProjectPath ?? parsed?.projectPath;
  if (!projectPath) {
    warnings.push('could not infer GitLab project path from git remote; pass --gitlab-project-path');
    return undefined;
  }

  const baseUrl = normalizeGitLabBaseUrl(
    options.gitlabBaseUrl ?? (parsed ? `https://${parsed.host}` : 'https://gitlab.com'),
  );

  const pat = options.gitlabToken ?? process.env.SECOND_BRAIN_GITLAB_TOKEN ?? process.env.GITLAB_TOKEN;
  if (!pat) {
    warnings.push(
      `no GitLab PAT provided (pass --gitlab-token or set SECOND_BRAIN_GITLAB_TOKEN); skipped webhook register for ${projectPath}.`,
    );
    return undefined;
  }

  const provider = options.gitlabProvider ?? new GitLabProvider({ fetchImpl: options.fetchImpl });
  await provider.auth({ baseUrl, pat });
  const project = await resolveGitLabProject({
    baseUrl,
    pat,
    path: projectPath,
    fetchImpl: options.fetchImpl,
  });
  const projectId = String(project.id);

  const relayUrl = await mintRelayChannel({ fetchImpl: options.fetchImpl });
  const secretValue = crypto.randomBytes(32).toString('hex');

  // Persist the secret BEFORE hitting the forge — if register fails and
  // we need to clean up, the caller can still find the key in the
  // keychain. If keychain fails, we refuse to proceed (security rev #11).
  const stored = await storeSecret(`gitlab.webhook-token:${projectId}`, secretValue);
  if (!stored.ok && stored.reason === 'runtime-error') {
    throw new Error(`keychain runtime error (${stored.message}); refusing to register webhook with a secret that can't be safely stored`);
  }
  // Also store PAT so unwire + watch can read it.
  await storeSecret(`gitlab.pat:${hostOf(baseUrl)}`, pat);

  const registration = await provider.registerWebhook({
    provider: 'gitlab',
    projectId,
    relayUrl,
    secret: { kind: 'token', value: secretValue },
  });

  return {
    provider: 'gitlab',
    projectId,
    webhookId: registration.webhookId,
    webhookAlreadyExisted: registration.alreadyExisted,
    relayUrl,
    baseUrl,
  };
}

async function wireGitHubProvider(
  repoRoot: string,
  options: WireOptions,
  warnings: string[],
): Promise<ProviderWireResult | undefined> {
  const remote = readGitRemoteOrigin(repoRoot);
  const parsed = remote ? parseGitRemote(remote) : null;

  // For GitHub, projectPath is "owner/repo"
  let owner = options.githubOwner;
  let repo = options.githubRepo;
  if (!owner || !repo) {
    if (parsed && (parsed.host === 'github.com' || parsed.host.includes('github'))) {
      const parts = parsed.projectPath.split('/');
      owner = owner ?? parts[0];
      repo = repo ?? parts[1];
    }
  }
  if (!owner || !repo) {
    warnings.push('could not infer GitHub owner/repo from git remote; pass --github-owner and --github-repo');
    return undefined;
  }

  const pat = options.githubToken ?? process.env.SECOND_BRAIN_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!pat) {
    warnings.push('no GitHub PAT provided; skipping webhook setup');
    return undefined;
  }

  const projectId = `${owner}/${repo}`;
  const provider = options.githubProvider ?? new GitHubProvider();
  await provider.auth({ baseUrl: 'https://api.github.com', pat });

  const relayUrl = await mintRelayChannel({ fetchImpl: options.fetchImpl });
  const secretKey = crypto.randomBytes(32).toString('hex');

  // Store HMAC secret + PAT in keychain
  const stored = await storeSecret(`github.webhook-secret:${projectId}`, secretKey);
  if (!stored.ok && stored.reason === 'runtime-error') {
    throw new Error('keychain runtime error; refusing to register webhook');
  }
  await storeSecret(`github.pat:github.com`, pat);

  const registration = await provider.registerWebhook({
    provider: 'github',
    projectId,
    relayUrl,
    secret: { kind: 'hmac', key: secretKey },
  });

  return {
    provider: 'github',
    projectId,
    webhookId: registration.webhookId,
    webhookAlreadyExisted: registration.alreadyExisted,
    relayUrl,
    baseUrl: 'https://api.github.com',
  };
}

function normalizeGitLabBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v4') ? trimmed : `${trimmed}/api/v4`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
