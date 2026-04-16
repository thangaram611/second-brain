import type { Command } from 'commander';
import { getServerUrl, buildAuthHeaders } from '../lib/config.js';

export function registerOwnershipCommand(program: Command): void {
  program
    .command('ownership')
    .description('Show file ownership scores')
    .argument('<path>', 'Repository-relative file path')
    .option('-l, --limit <n>', 'Max owners to return', '3')
    .option('--json', 'Output as JSON')
    .option('--server-url <url>', 'Server URL (default: http://localhost:7430)')
    .option('--token <token>', 'Bearer token')
    .action(
      async (
        filePath: string,
        options: {
          limit?: string;
          json?: boolean;
          serverUrl?: string;
          token?: string;
        },
      ) => {
        const { runOwnership } = await import('../ownership.js');
        await runOwnership({
          path: filePath,
          limit: options.limit ? Number(options.limit) : undefined,
          json: options.json,
          serverUrl: options.serverUrl,
          token: options.token,
        });
      },
    );
}
