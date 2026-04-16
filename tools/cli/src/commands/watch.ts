import type { Command } from 'commander';
import * as path from 'node:path';
import {
  PipelineRunner,
  ASTCollector,
  DocCollector,
  createWatcher,
} from '@second-brain/collectors';
import { openBrain } from '../lib/config.js';

export function registerWatchCommand(program: Command): void {
  // First watch: re-index on file change (AST + docs).
  // NOTE: overridden by the daemon watch below; kept for backwards compat.
  program
    .command('watch')
    .description('Watch a repository and re-index on change (AST + docs)')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--repo <path>', 'Repository path', '.')
    .option('--debounce <ms>', 'Debounce window for batched changes', '500')
    .action(async (options: { namespace: string; repo: string; debounce: string }) => {
      const repoPath = path.resolve(options.repo);
      const debounceMs = parseInt(options.debounce, 10);

      const runIndex = async (reason: string): Promise<void> => {
        const brain = openBrain();
        try {
          const runner = new PipelineRunner(brain);
          runner.register(new ASTCollector());
          runner.register(new DocCollector({ watchPaths: ['.'] }));
          const summary = await runner.run({
            namespace: options.namespace,
            repoPath,
            ignorePatterns: ['node_modules', 'dist', '.git', '.turbo', 'coverage'],
            onProgress: () => {},
          });
          console.log(
            `[${new Date().toISOString()}] ${reason} → ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`,
          );
        } finally {
          brain.close();
        }
      };

      console.log(`Watching ${repoPath} (debounce ${debounceMs}ms). Ctrl-C to stop.`);
      await runIndex('initial index');

      const handle = createWatcher({
        roots: [repoPath],
        debounceMs,
        onBatch: async (batch) => {
          await runIndex(`re-index after ${batch.length} change(s)`);
        },
        onError: (err) => console.error('[watch]', err),
      });
      await handle.ready;

      const shutdown = async (): Promise<void> => {
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      // Keep process alive.
      await new Promise(() => {});
    });

  // Second watch: file-change + branch-change daemon (overrides the above).
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
