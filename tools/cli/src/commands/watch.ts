import type { Command } from 'commander';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Run the file-change + branch-change daemon for a wired repo')
    .option('--repo <path>', 'Repo root (defaults to cwd)')
    .option('-n, --namespace <ns>', 'Override namespace (defaults to wired value or personal)')
    .option('--server-url <url>', 'Server URL (defaults to http://localhost:7430 or $SECOND_BRAIN_SERVER_URL)')
    .option('--token <token>', 'Bearer token (or $SECOND_BRAIN_TOKEN)')
    .option('--author-email <email>', 'Override git config user.email')
    .option('--author-name <name>', 'Override git config user.name')
    .action(async (options: {
      repo?: string;
      namespace?: string;
      serverUrl?: string;
      token?: string;
      authorEmail?: string;
      authorName?: string;
    }) => {
      const { runWatch } = await import('../git-context-daemon.js');
      const repo = options.repo ?? process.cwd();
      const handle = await runWatch({
        repo,
        namespace: options.namespace,
        serverUrl: options.serverUrl,
        bearerToken: options.token,
        authorEmail: options.authorEmail,
        authorName: options.authorName,
      });
      const currentBranch = await handle.currentBranch();
      console.log(`[watch] ready — repo=${repo} branch=${currentBranch}`);
      console.log('[watch] Press Ctrl-C to stop.');
    });
}
