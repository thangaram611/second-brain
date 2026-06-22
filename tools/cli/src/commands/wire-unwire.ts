import type { Command } from 'commander';

export function registerWireUnwireCommands(program: Command): void {
  // --- brain wire ---
  program
    .command('wire')
    .description('One-shot wire-up: git hooks + claude hooks + wiredRepos entry (+ optional forge provider)')
    .option('--repo <path>', 'Repo root (defaults to `git rev-parse --show-toplevel`)')
    .option('-n, --namespace <ns>', 'Namespace (overrides project config)')
    .option('--server-url <url>', 'Server URL')
    .option('--token <token>', 'Bearer token embedded into local git hooks')
    .option('--require-project', 'Fail if no project namespace is set (for CI/team setups)')
    .option('--no-claude', 'Skip Claude Code session hook install')
    .option('--skip-if-claude-mem', 'Abort if claude-mem hooks are present')
    .option('--provider <name>', 'Forge provider to wire (gitlab|github)')
    .option('--gitlab-url <url>', 'GitLab base URL (auto-detected from origin when omitted)')
    .option('--gitlab-token <pat>', 'GitLab PAT (falls back to SECOND_BRAIN_GITLAB_TOKEN env)')
    .option('--gitlab-project-path <path>', 'group/subgroup/project (auto-detected when omitted)')
    .option('--github-token <pat>', 'GitHub PAT (falls back to SECOND_BRAIN_GITHUB_TOKEN or GITHUB_TOKEN env)')
    .option('--github-base-url <url>', 'GitHub API base URL (auto-detected for enterprise remotes when omitted)')
    .option('--github-owner <owner>', 'GitHub owner/org (auto-detected from origin when omitted)')
    .option('--github-repo <repo>', 'GitHub repo name (auto-detected from origin when omitted)')
    .action(async (options: {
      repo?: string;
      namespace?: string;
      serverUrl?: string;
      token?: string;
      requireProject?: boolean;
      claude?: boolean;
      skipIfClaudeMem?: boolean;
      provider?: string;
      gitlabUrl?: string;
      gitlabToken?: string;
      gitlabProjectPath?: string;
      githubToken?: string;
      githubBaseUrl?: string;
      githubOwner?: string;
      githubRepo?: string;
    }) => {
      const { runWire } = await import('../wire.js');
      try {
        let provider: 'gitlab' | 'github' | undefined;
        if (options.provider !== undefined) {
          if (options.provider !== 'gitlab' && options.provider !== 'github') {
            throw new Error(`--provider must be gitlab or github (got ${JSON.stringify(options.provider)})`);
          }
          provider = options.provider;
        }
        const result = await runWire({
          repo: options.repo,
          namespace: options.namespace,
          serverUrl: options.serverUrl,
          bearerToken: options.token,
          requireProject: options.requireProject,
          installAssistants: options.claude === false ? [] : undefined,
          skipIfClaudeMem: options.skipIfClaudeMem,
          provider,
          gitlabBaseUrl: options.gitlabUrl,
          gitlabToken: options.gitlabToken,
          gitlabProjectPath: options.gitlabProjectPath,
          githubToken: options.githubToken,
          githubBaseUrl: options.githubBaseUrl,
          githubOwner: options.githubOwner,
          githubRepo: options.githubRepo,
        });
        console.log(`Wired: ${result.repoRoot}`);
        console.log(`  namespace: ${result.namespace}`);
        console.log(`  author:    ${result.authorEmail ?? '(not set)'}`);
        console.log(`  git hooks: ${result.gitHooks.installed.join(', ')}`);
        if (result.gitHooks.backups.length > 0) {
          console.log(
            `  backups:   ${result.gitHooks.backups.map((b) => `${b.name}→${b.path}`).join(', ')}`,
          );
        }
        if (result.claudeHooks) {
          console.log(
            `  claude hooks: ${result.claudeHooks.addedHooks.length ? result.claudeHooks.addedHooks.join(', ') : '(already present)'}`,
          );
        }
        if (result.providerResult) {
          const p = result.providerResult;
          console.log(
            `  provider:  ${p.provider} projectId=${p.projectId} hook=${p.webhookId}${p.webhookAlreadyExisted ? ' (reused)' : ''}`,
          );
          console.log(`  relay:     ${p.relayUrl}`);
          console.log(`  server env: export ${p.serverSecretEnv.name}=${p.serverSecretEnv.value}`);
        }
        console.log(`  config:    ${result.configPath}`);
        for (const w of result.warnings) {
          console.log(`  [warn] ${w}`);
        }
        console.log('');
        console.log('Next: start the file-watch daemon with:');
        console.log(`  ${result.watchCommand}`);
      } catch (err) {
        console.error(`wire failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // --- brain unwire ---
  program
    .command('unwire')
    .description('Reverse `brain wire` — remove git hooks, drop wiredRepos entry, unregister webhook')
    .option('--repo <path>', 'Repo root')
    .option('--remove-claude-hooks', 'Also remove Claude Code session hooks (affects all repos)')
    .option('--purge', "Delete all entities and relations in this repo's namespace (irreversible; refuses 'personal')")
    .option('-y, --yes', 'Skip the --purge confirmation prompt (required to purge non-interactively)')
    .option('--force', 'Proceed past provider API failures (401, timeout). 404 is always success.')
    .action(
      async (options: {
        repo?: string;
        removeClaudeHooks?: boolean;
        purge?: boolean;
        yes?: boolean;
        force?: boolean;
      }) => {
        const { runUnwire } = await import('../unwire.js');
        try {
          const result = await runUnwire({
            repo: options.repo,
            removeClaudeHooks: options.removeClaudeHooks,
            purge: options.purge,
            force: options.force,
          });
          console.log(`Unwired: ${result.repoRoot}`);
          console.log(`  git hooks removed:  ${result.gitHooks.removed.join(', ') || '(none)'}`);
          if (result.gitHooks.restored.length > 0) {
            console.log(`  git hooks restored: ${result.gitHooks.restored.join(', ')}`);
          }
          console.log(`  config entry removed:  ${result.configEntryRemoved}`);
          console.log(`  provider unregistered: ${result.providerUnregistered}`);
          console.log(`  keychain cleaned:      ${result.keychainCleaned} entry/ies`);
          if (result.claudeRemoved) {
            console.log(`  claude hooks removed:  ${result.claudeRemoved.join(', ') || '(none)'}`);
          }
          for (const w of result.warnings) console.log(`  warning: ${w}`);
          if (options.purge) {
            await runPurge(result.namespace, options.yes === true);
          }
        } catch (err) {
          console.error(`brain unwire: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );
}

/**
 * Delete all knowledge-graph data in the unwired repo's namespace. Invoked only
 * for `brain unwire --purge`. Refuses the `personal` namespace outright so a
 * repo that fell back to `personal` (no project namespace set) can never wipe
 * the user's personal brain. Requires interactive confirmation, or `--yes` for
 * non-interactive use.
 */
async function runPurge(namespace: string | null, skipConfirm: boolean): Promise<void> {
  if (!namespace) {
    console.log('  [purge] skipped — no namespace was recorded for this repo.');
    return;
  }
  if (namespace === 'personal') {
    console.log("  [purge] refused — repo maps to the 'personal' namespace; refusing to delete your personal brain.");
    return;
  }

  const fs = await import('node:fs');
  const { getDbPath } = await import('../lib/config.js');
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.log(`  [purge] skipped — no brain database at ${dbPath}.`);
    return;
  }

  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      console.log(`  [purge] skipped — re-run with --yes to purge namespace '${namespace}' non-interactively.`);
      return;
    }
    const p = await import('@clack/prompts');
    const answer = await p.confirm({
      message: `Purge ALL entities and relations in namespace '${namespace}'? This cannot be undone.`,
      initialValue: false,
    });
    if (p.isCancel(answer) || answer !== true) {
      console.log('  [purge] cancelled — namespace data left intact.');
      return;
    }
  }

  const { Brain } = await import('@second-brain/core');
  const brain = new Brain({ path: dbPath });
  try {
    const res = brain.purgeNamespace(namespace);
    console.log(
      `  purged namespace '${namespace}': ${res.entitiesDeleted} entities, ${res.relationsDeleted} relations`,
    );
  } finally {
    brain.close();
  }
}
