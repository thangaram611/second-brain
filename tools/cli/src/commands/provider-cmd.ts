/**
 * `brain provider <add|refresh|remove> <gitlab|github>` — the noun-verb surface
 * for forge webhook wiring, split off `brain wire`. `add`/`refresh` delegate to
 * `runWire` with assistants skipped (webhook register is idempotent — reused by
 * URL on re-run); `remove` calls the factored `runProviderRemove`, which
 * unregisters the webhook + cleans keychain without touching git/assistant hooks.
 */

import type { Command } from 'commander';

function parseProvider(value: string): 'gitlab' | 'github' {
  if (value !== 'gitlab' && value !== 'github') {
    throw new Error(`provider must be gitlab or github (got ${JSON.stringify(value)})`);
  }
  return value;
}

interface ProviderWireFlags {
  repo?: string;
  gitlabUrl?: string;
  gitlabToken?: string;
  gitlabProjectPath?: string;
  githubToken?: string;
  githubBaseUrl?: string;
  githubOwner?: string;
  githubRepo?: string;
}

interface ProviderRemoveFlags {
  repo?: string;
  force?: boolean;
}

async function runProviderWire(name: string, options: ProviderWireFlags): Promise<void> {
  const { runWire } = await import('../wire.js');
  const provider = parseProvider(name);
  const result = await runWire({
    repo: options.repo,
    provider,
    gitlabBaseUrl: options.gitlabUrl,
    gitlabToken: options.gitlabToken,
    gitlabProjectPath: options.gitlabProjectPath,
    githubToken: options.githubToken,
    githubBaseUrl: options.githubBaseUrl,
    githubOwner: options.githubOwner,
    githubRepo: options.githubRepo,
    // Provider-only flow: leave git/assistant hooks to `brain wire`.
    installAssistants: [],
  });
  if (result.providerResult) {
    const p = result.providerResult;
    console.log(
      `Provider ${p.provider}: projectId=${p.projectId} hook=${p.webhookId}${p.webhookAlreadyExisted ? ' (reused)' : ''}`,
    );
    console.log(`  relay:      ${p.relayUrl}`);
    console.log(`  server env: export ${p.serverSecretEnv.name}=${p.serverSecretEnv.value}`);
  } else {
    console.log(`Provider ${provider}: no webhook registered.`);
  }
  for (const w of result.warnings) console.log(`  [warn] ${w}`);
}

export function registerProviderCommands(program: Command): void {
  const provider = program
    .command('provider')
    .description('Manage forge webhook wiring (gitlab|github) for the current repo');

  const wireOptions = (cmd: Command): Command =>
    cmd
      .option('--repo <path>', 'Repo root (defaults to `git rev-parse --show-toplevel`)')
      .option('--gitlab-url <url>', 'GitLab base URL (auto-detected from origin when omitted)')
      .option('--gitlab-token <pat>', 'GitLab PAT (falls back to SECOND_BRAIN_GITLAB_TOKEN env)')
      .option('--gitlab-project-path <path>', 'group/subgroup/project (auto-detected when omitted)')
      .option('--github-token <pat>', 'GitHub PAT (falls back to SECOND_BRAIN_GITHUB_TOKEN or GITHUB_TOKEN env)')
      .option('--github-base-url <url>', 'GitHub API base URL (auto-detected for enterprise remotes when omitted)')
      .option('--github-owner <owner>', 'GitHub owner/org (auto-detected from origin when omitted)')
      .option('--github-repo <repo>', 'GitHub repo name (auto-detected from origin when omitted)');

  wireOptions(provider.command('add <provider>'))
    .description('Register the forge webhook for this repo (gitlab|github)')
    .action(async (name: string, options: ProviderWireFlags) => {
      try {
        await runProviderWire(name, options);
      } catch (err) {
        console.error(`provider add: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  wireOptions(provider.command('refresh <provider>'))
    .description('Re-register / repair the forge webhook for this repo (gitlab|github)')
    .action(async (name: string, options: ProviderWireFlags) => {
      try {
        await runProviderWire(name, options);
      } catch (err) {
        console.error(`provider refresh: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  provider
    .command('remove <provider>')
    .description('Unregister the forge webhook + clean keychain (leaves git/assistant hooks)')
    .option('--repo <path>', 'Repo root (defaults to `git rev-parse --show-toplevel`)')
    .option('--force', 'Proceed past provider API failures (401, timeout). 404 is always success.')
    .action(async (name: string, options: ProviderRemoveFlags) => {
      try {
        const expected = parseProvider(name);
        const { runProviderRemove } = await import('../unwire.js');
        const result = await runProviderRemove({ repo: options.repo, force: options.force });
        console.log(`Provider ${expected} removed for ${result.repoRoot}`);
        console.log(`  webhook unregistered:  ${result.providerUnregistered}`);
        console.log(`  keychain cleaned:      ${result.keychainCleaned} entry/ies`);
        console.log(`  provider metadata:     ${result.providerMetadataCleared ? 'cleared' : '(none recorded)'}`);
        for (const w of result.warnings) console.log(`  warning: ${w}`);
      } catch (err) {
        console.error(`provider remove: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
