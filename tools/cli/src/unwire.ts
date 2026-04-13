import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

export interface UnwireOptions {
  repo?: string;
  /** Also remove Claude session hooks. Default false (other repos may still use them). */
  removeClaudeHooks?: boolean;
  /** Purge project-namespace observations created by this phase's writers (watch/git-hook/gitlab/github). Default false — history preserved. */
  purge?: boolean;
}

export interface UnwireResult {
  repoRoot: string;
  repoHash: string;
  gitHooks: UninstallGitHooksResult;
  configEntryRemoved: boolean;
  claudeRemoved: string[] | null;
  purgeRan: boolean;
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
  const repoRoot = resolveRepoRoot(options.repo);
  const gitHooks = uninstallGitHooks(repoRoot);

  let claudeRemoved: string[] | null = null;
  if (options.removeClaudeHooks) {
    const res = uninstallClaudeHooks({ scope: 'user' });
    claudeRemoved = res.removed;
  }

  const repoHash = computeRepoHash(repoRoot);
  const wired = loadWiredRepos();
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

  // Purge is deferred: the DB delete needs the Brain instance + namespace
  // from the config entry we just removed. Run it via the CLI before
  // unwire if needed (documented in the plan). This function stays pure
  // (filesystem + config only) so 10.1 has no DB dependency.
  const purgeRan = false;
  if (options.purge) {
    // Signal to caller; actual purge is a separate CLI step in 10.4.
    // For 10.1 we just note that purge was requested.
  }

  return {
    repoRoot,
    repoHash,
    gitHooks,
    configEntryRemoved,
    claudeRemoved,
    purgeRan,
  };
}
