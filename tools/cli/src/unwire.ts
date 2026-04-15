import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { GitLabProvider } from '@second-brain/collectors';
import {
  uninstallClaudeHooks,
  uninstallGitHooks,
  type UninstallGitHooksResult,
} from './install-hooks.js';
import {
  computeRepoHash,
  loadWiredRepos,
  saveWiredRepos,
} from './git-context-daemon.js';
import { deleteSecret, resolveSecret } from './keychain.js';

export interface UnwireOptions {
  repo?: string;
  /** Also remove Claude session hooks. Default false (other repos may still use them). */
  removeClaudeHooks?: boolean;
  /** Purge project-namespace observations created by this phase's writers (watch/git-hook/gitlab/github). Default false — history preserved. */
  purge?: boolean;
  /** Phase 10.3: proceed past provider API failures (401, timeout). 404 is always treated as success. */
  force?: boolean;
  /** Inject provider for tests. */
  gitlabProvider?: GitLabProvider;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface UnwireResult {
  repoRoot: string;
  repoHash: string;
  gitHooks: UninstallGitHooksResult;
  configEntryRemoved: boolean;
  claudeRemoved: string[] | null;
  purgeRan: boolean;
  providerUnregistered: boolean;
  keychainCleaned: number;
  warnings: string[];
}

function resolveRepoRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: 2000,
  }).trim();
  return path.resolve(out);
}

export async function runUnwire(options: UnwireOptions = {}): Promise<UnwireResult> {
  // Share the same lock as `brain wire` so the two never interleave (rev #4).
  const configDir = path.join(os.homedir(), '.second-brain');
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = path.join(configDir, '.wire.lock');
  if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, '', 'utf8');
  const release = await lockfile.lock(lockPath, {
    realpath: false,
    retries: 0,
    stale: 60_000,
  });
  try {
    return await runUnwireInternal(options);
  } finally {
    await release();
  }
}

async function runUnwireInternal(options: UnwireOptions): Promise<UnwireResult> {
  const warnings: string[] = [];
  const repoRoot = resolveRepoRoot(options.repo);
  const repoHash = computeRepoHash(repoRoot);
  const wired = loadWiredRepos();
  const entry = wired.wiredRepos[repoHash];

  // ── Phase 10.3: unregister provider webhook ──────────────────────────
  let providerUnregistered = false;
  if (entry?.providerId === 'gitlab' && entry.gitlabProjectId && entry.webhookId) {
    const baseUrl = entry.gitlabBaseUrl ?? 'https://gitlab.com/api/v4';
    const host = hostOf(baseUrl);
    const patRes = await resolveSecret(`gitlab.pat:${host}`, 'SECOND_BRAIN_GITLAB_TOKEN');
    if (patRes.value) {
      const provider =
        options.gitlabProvider ??
        new GitLabProvider({ baseUrl, pat: patRes.value, fetchImpl: options.fetchImpl });
      try {
        await provider.unregisterWebhook({
          provider: 'gitlab',
          projectId: entry.gitlabProjectId,
          webhookId: entry.webhookId,
        });
        providerUnregistered = true;
      } catch (err) {
        if (!options.force) {
          throw new Error(
            `failed to unregister GitLab webhook (${errMsg(err)}). Pass --force to proceed and remove the webhook manually in the GitLab UI.`,
          );
        }
        warnings.push(
          `GitLab webhook unregister failed (${errMsg(err)}). Delete webhook id=${entry.webhookId} manually at ${entry.gitlabBaseUrl ?? 'gitlab.com'}.`,
        );
      }
    } else if (!options.force) {
      throw new Error(
        `no GitLab PAT available in keychain or SECOND_BRAIN_GITLAB_TOKEN env. Pass --force to proceed with local cleanup only.`,
      );
    } else {
      warnings.push('no GitLab PAT available — skipped webhook unregister; remove it manually.');
    }
  }

  // ── Phase 10.3: delete keychain entries ──────────────────────────────
  let keychainCleaned = 0;
  if (entry?.gitlabProjectId) {
    const r = await deleteSecret(`gitlab.webhook-token:${entry.gitlabProjectId}`);
    if (r.ok && r.value) keychainCleaned++;
  }
  if (entry?.gitlabBaseUrl) {
    const r = await deleteSecret(`gitlab.pat:${hostOf(entry.gitlabBaseUrl)}`);
    if (r.ok && r.value) keychainCleaned++;
  }

  // ── Remove git hooks ─────────────────────────────────────────────────
  const gitHooks = uninstallGitHooks(repoRoot);

  let claudeRemoved: string[] | null = null;
  if (options.removeClaudeHooks) {
    const res = uninstallClaudeHooks({ scope: 'user' });
    claudeRemoved = res.removed;
  }

  let configEntryRemoved = false;
  if (wired.wiredRepos[repoHash]) {
    delete wired.wiredRepos[repoHash];
    saveWiredRepos(wired);
    configEntryRemoved = true;
  }

  // Clean up per-repo sidecar dir if empty.
  try {
    const dir = path.join(repoRoot, '.second-brain');
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore
  }

  // Purge is deferred to the caller with a live Brain instance.
  const purgeRan = false;

  return {
    repoRoot,
    repoHash,
    gitHooks,
    configEntryRemoved,
    claudeRemoved,
    purgeRan,
    providerUnregistered,
    keychainCleaned,
    warnings,
  };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
