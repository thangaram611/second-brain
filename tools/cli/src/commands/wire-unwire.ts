import type { Command } from 'commander';

export function registerWireUnwireCommands(program: Command): void {
  // --- brain wire ---
  program
    .command('wire')
    .description('One-shot wire-up: git hooks + claude hooks + wiredRepos entry (+ optional GitLab provider)')
    .option('--repo <path>', 'Repo root (defaults to `git rev-parse --show-toplevel`)')
    .option('-n, --namespace <ns>', 'Namespace (overrides project config)')
    .option('--server-url <url>', 'Server URL')
    .option('--token <token>', 'Bearer token')
    .option('--require-project', 'Fail if no project namespace is set (for CI/team setups)')
    .option('--no-claude', 'Skip Claude Code session hook install')
    .option('--skip-if-claude-mem', 'Abort if claude-mem hooks are present')
    .option('--provider <name>', 'Forge provider to wire (gitlab)')
    .option('--gitlab-url <url>', 'GitLab base URL (auto-detected from origin when omitted)')
    .option('--gitlab-token <pat>', 'GitLab PAT (falls back to SECOND_BRAIN_GITLAB_TOKEN env)')
    .option('--gitlab-project-path <path>', 'group/subgroup/project (auto-detected when omitted)')
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
    }) => {
      const { runWire } = await import('../wire.js');
      try {
        const result = await runWire({
          repo: options.repo,
          namespace: options.namespace,
          serverUrl: options.serverUrl,
          bearerToken: options.token,
          requireProject: options.requireProject,
          installClaudeSession: options.claude !== false,
          skipIfClaudeMem: options.skipIfClaudeMem,
          provider: options.provider === 'gitlab' ? 'gitlab' : undefined,
          gitlabBaseUrl: options.gitlabUrl,
          gitlabToken: options.gitlabToken,
          gitlabProjectPath: options.gitlabProjectPath,
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
    .option('--purge', 'Signal that project observations should be purged (DB purge lands in 10.4)')
    .option('--force', 'Proceed past provider API failures (401, timeout). 404 is always success.')
    .action(
      async (options: {
        repo?: string;
        removeClaudeHooks?: boolean;
        purge?: boolean;
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
            console.log(`  [note] --purge requested but DB purge ships in sub-phase 10.4`);
          }
        } catch (err) {
          console.error(`brain unwire: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );
}
