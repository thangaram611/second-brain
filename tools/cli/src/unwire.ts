import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { GitLabProvider, GitHubProvider } from '@second-brain/collectors';
import { ADAPTERS } from './adapters/index.js';
import { hostFromUrl } from './lib/config.js';
import { gitRepoRoot } from './lib/repo.js';
import {
  uninstallGitHooks,
  type UninstallGitHooksResult,
} from './install-git-hooks.js';
import {
  computeRepoHash,
  loadWiredRepos,
  saveWiredRepos,
  type WiredReposEntry,
} from './git-context-daemon.js';
import { deleteSecret, resolveSecret } from './keychain.js';

export interface UnwireOptions {
  repo?: string;
  /** Home directory for `~/.second-brain` config + lock. Defaults to `os.homedir()`.
      Threaded explicitly so tests avoid mutating `process.env.HOME` (see WireOptions.home). */
  home?: string;
  /** Also remove Claude session hooks. Default false (other repos may still use them). */
  removeClaudeHooks?: boolean;
  /** Purge project-namespace observations created by this phase's writers (watch/git-hook/gitlab/github). Default false — history preserved. */
  purge?: boolean;
  /** Phase 10.3: proceed past provider API failures (401, timeout). 404 is always treated as success. */
  force?: boolean;
  /** Inject provider for tests. */
  gitlabProvider?: GitLabProvider;
  /** Inject GitHub provider for tests. */
  githubProvider?: GitHubProvider;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface UnwireResult {
  repoRoot: string;
  repoHash: string;
  /** Namespace recorded for this repo, captured before the wiredRepos entry is removed. Null if the repo was not wired. Lets the caller run `--purge` against the right namespace. */
  namespace: string | null;
  gitHooks: UninstallGitHooksResult;
  configEntryRemoved: boolean;
  claudeRemoved: string[] | null;
  purgeRan: boolean;
  providerUnregistered: boolean;
  keychainCleaned: number;
  warnings: string[];
}

export async function runUnwire(options: UnwireOptions = {}): Promise<UnwireResult> {
  // Share the same lock as `brain wire` so the two never interleave (rev #4).
  const home = options.home ?? os.homedir();
  const configDir = path.join(home, '.second-brain');
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

export interface ProviderRemoveOptions {
  repo?: string;
  /** Home directory for `~/.second-brain`. Defaults to `os.homedir()` (see WireOptions.home). */
  home?: string;
  /** Proceed past provider API failures (401, timeout). 404 is always success. */
  force?: boolean;
  gitlabProvider?: GitLabProvider;
  githubProvider?: GitHubProvider;
  fetchImpl?: typeof fetch;
}

export interface ProviderRemoveResult {
  repoRoot: string;
  providerUnregistered: boolean;
  keychainCleaned: number;
  /** Whether the wiredRepos entry's provider metadata was cleared (repo stays wired for hooks). */
  providerMetadataCleared: boolean;
  warnings: string[];
}

/**
 * Remove only the forge provider wiring for a repo — unregister the webhook,
 * clean keychain secrets, and strip provider metadata from the wiredRepos entry
 * while LEAVING the repo wired (git/assistant hooks untouched). Backs
 * `brain provider remove`; `brain unwire` does the full teardown instead.
 */
export async function runProviderRemove(
  options: ProviderRemoveOptions = {},
): Promise<ProviderRemoveResult> {
  const home = options.home ?? os.homedir();
  const configDir = path.join(home, '.second-brain');
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = path.join(configDir, '.wire.lock');
  if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, '', 'utf8');
  const release = await lockfile.lock(lockPath, { realpath: false, retries: 0, stale: 60_000 });
  try {
    const repoRoot = gitRepoRoot({ explicit: options.repo, throwIfMissing: true });
    const repoHash = computeRepoHash(repoRoot);
    const wired = loadWiredRepos(home);
    const entry = wired.wiredRepos[repoHash];

    const prov = await unregisterProvider(entry, {
      force: options.force,
      gitlabProvider: options.gitlabProvider,
      githubProvider: options.githubProvider,
      fetchImpl: options.fetchImpl,
    });

    let providerMetadataCleared = false;
    if (entry?.providerId) {
      // Keep the repo wired; drop only provider fields.
      wired.wiredRepos[repoHash] = {
        repoHash: entry.repoHash,
        absPath: entry.absPath,
        namespace: entry.namespace,
        installedAt: entry.installedAt,
      };
      saveWiredRepos(wired, home);
      providerMetadataCleared = true;
    }

    return {
      repoRoot,
      providerUnregistered: prov.providerUnregistered,
      keychainCleaned: prov.keychainCleaned,
      providerMetadataCleared,
      warnings: prov.warnings,
    };
  } finally {
    await release();
  }
}

async function runUnwireInternal(options: UnwireOptions): Promise<UnwireResult> {
  const home = options.home ?? os.homedir();
  const warnings: string[] = [];
  const repoRoot = gitRepoRoot({ explicit: options.repo, throwIfMissing: true });
  const repoHash = computeRepoHash(repoRoot);
  const wired = loadWiredRepos(home);
  const entry = wired.wiredRepos[repoHash];
  // Capture the namespace now — the wiredRepos entry is deleted below, so the
  // caller (`brain unwire --purge`) can't look it up afterwards.
  const namespace = entry?.namespace ?? null;

  // ── Phase 10.3: unregister provider webhook + clean keychain ─────────
  const prov = await unregisterProvider(entry, options);
  const { providerUnregistered, keychainCleaned } = prov;
  warnings.push(...prov.warnings);

  // ── Remove git hooks ─────────────────────────────────────────────────
  const gitHooks = uninstallGitHooks(repoRoot);

  let claudeRemoved: string[] | null = null;
  if (options.removeClaudeHooks) {
    const res = ADAPTERS.claude.uninstall({
      scope: 'user',
      home,
      cwd: repoRoot,
    });
    claudeRemoved = res.removed;
  }

  let configEntryRemoved = false;
  if (wired.wiredRepos[repoHash]) {
    delete wired.wiredRepos[repoHash];
    saveWiredRepos(wired, home);
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
    namespace,
    gitHooks,
    configEntryRemoved,
    claudeRemoved,
    purgeRan,
    providerUnregistered,
    keychainCleaned,
    warnings,
  };
}

interface UnregisterProviderOptions {
  /** Proceed past provider API failures (401, timeout). 404 is always success. */
  force?: boolean;
  /** Inject provider for tests. */
  gitlabProvider?: GitLabProvider;
  /** Inject GitHub provider for tests. */
  githubProvider?: GitHubProvider;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Unregister a wired repo's forge webhook and delete its keychain secrets.
 * Shared by `brain unwire` and `brain provider remove` so the webhook lifecycle
 * stays in one place. Returns counts plus any non-fatal warnings; throws on a
 * provider API failure unless `force` is set.
 */
async function unregisterProvider(
  entry: WiredReposEntry | undefined,
  options: UnregisterProviderOptions = {},
): Promise<{ providerUnregistered: boolean; keychainCleaned: number; warnings: string[] }> {
  const warnings: string[] = [];
  let providerUnregistered = false;

  if (entry?.providerId === 'gitlab' && entry.projectId && entry.webhookId) {
    const baseUrl = entry.providerBaseUrl ?? 'https://gitlab.com/api/v4';
    const host = hostFromUrl(baseUrl, baseUrl);
    const patRes = await resolveSecret(`gitlab.pat:${host}`, 'SECOND_BRAIN_GITLAB_TOKEN');
    if (patRes.value) {
      const provider =
        options.gitlabProvider ??
        new GitLabProvider({ baseUrl, pat: patRes.value, fetchImpl: options.fetchImpl });
      try {
        await provider.unregisterWebhook({
          provider: 'gitlab',
          projectId: entry.projectId,
          webhookId: entry.webhookId,
        });
        providerUnregistered = true;
      } catch (err) {
        if (!options.force) {
          throw new Error(
            `failed to unregister GitLab webhook (${errMsg(err)}). Pass --force to proceed and remove the webhook manually in the GitLab UI.`,
            { cause: err },
          );
        }
        warnings.push(
          `GitLab webhook unregister failed (${errMsg(err)}). Delete webhook id=${entry.webhookId} manually at ${entry.providerBaseUrl ?? 'gitlab.com'}.`,
        );
      }
    } else if (!options.force) {
      throw new Error(
        `no GitLab PAT available in keychain or SECOND_BRAIN_GITLAB_TOKEN env. Pass --force to proceed with local cleanup only.`,
      );
    } else {
      warnings.push('no GitLab PAT available — skipped webhook unregister; remove it manually.');
    }
  } else if (entry?.providerId === 'github' && entry.projectId && entry.webhookId) {
    const patRes = await resolveSecret('github.pat:github.com', 'SECOND_BRAIN_GITHUB_TOKEN');
    if (patRes.value) {
      const provider = options.githubProvider ?? new GitHubProvider({ pat: patRes.value });
      try {
        await provider.unregisterWebhook({
          provider: 'github',
          projectId: entry.projectId,
          webhookId: entry.webhookId,
        });
        providerUnregistered = true;
      } catch (err) {
        if (!options.force) {
          throw new Error(`failed to unregister GitHub webhook (${errMsg(err)}). Pass --force to proceed.`, {
            cause: err,
          });
        }
        warnings.push(`GitHub webhook unregister failed (${errMsg(err)}). Delete it manually.`);
      }
    } else if (!options.force) {
      throw new Error('no GitHub PAT available. Pass --force for local-only cleanup.');
    } else {
      warnings.push('no GitHub PAT — skipped webhook unregister.');
    }
  } else if (entry?.providerId === 'custom') {
    warnings.push('custom provider: remove the webhook manually on your forge.');
  }

  // ── Delete keychain entries ──────────────────────────────────────────
  let keychainCleaned = 0;
  if (entry?.providerId === 'gitlab' && entry?.projectId) {
    const r = await deleteSecret(`gitlab.webhook-token:${entry.projectId}`);
    if (r.ok && r.value) keychainCleaned++;
  }
  if (entry?.providerId === 'gitlab' && entry?.providerBaseUrl) {
    const r = await deleteSecret(`gitlab.pat:${hostFromUrl(entry.providerBaseUrl, entry.providerBaseUrl)}`);
    if (r.ok && r.value) keychainCleaned++;
  }
  if (entry?.providerId === 'github' && entry.projectId) {
    const r1 = await deleteSecret(`github.webhook-secret:${entry.projectId}`);
    if (r1.ok && r1.value) keychainCleaned++;
    const r2 = await deleteSecret(`github.pat:github.com`);
    if (r2.ok && r2.value) keychainCleaned++;
  }

  return { providerUnregistered, keychainCleaned, warnings };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
