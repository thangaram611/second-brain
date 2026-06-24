import type { Command } from 'commander';
import { URL } from 'node:url';
import { getServerUrl } from '../lib/config.js';
import { gitRepoRoot } from '../lib/repo.js';
import { loadTeamManifest } from '../team-manifest.js';
import { readCredentials } from '../lib/resolve-token.js';

/**
 * Resolve the namespace to send to the server. Priority:
 *   1. Explicit `--namespace` flag (if provided).
 *   2. `.second-brain/team.json` `namespace` field, found by walking up from cwd.
 *   3. `~/.second-brain/credentials/<host>.json` `namespace` field for the
 *      configured server host.
 *   4. `personal` (solo-mode default — matches `decide`/`add` flag default).
 *
 * If a manifest is present but broken (`unreadable` / `invalid-json` /
 * `invalid-schema`), we throw rather than silently falling through to
 * `'personal'` — silent fallback in a team repo would return mis-scoped
 * ownership data with no warning. The caller must surface the error.
 * `not-found` (manifest simply absent) is the legitimate solo path and
 * falls through normally.
 */
export function resolveOwnershipNamespace(opts: {
  explicit?: string;
  serverUrl?: string;
  cwd?: string;
  homeDir?: string;
}): string {
  if (opts.explicit && opts.explicit.length > 0) return opts.explicit;

  const startDir = opts.cwd ?? process.cwd();
  const repoRoot = gitRepoRoot({ cwd: startDir });
  if (repoRoot) {
    const loaded = loadTeamManifest(repoRoot);
    if (loaded.ok) return loaded.manifest.namespace;
    // 'not-found' is the legitimate solo path — fall through to credentials.
    // Any other reason means the team repo is misconfigured; refuse to
    // silently default to 'personal' which would return wrong-scope data.
    if (loaded.reason !== 'not-found') {
      const detail = loaded.detail ? `: ${loaded.detail}` : '';
      throw new Error(
        `team manifest at ${repoRoot}/.second-brain/team.json is ${loaded.reason}${detail}. ` +
          `Refusing to default to namespace 'personal' inside a team repo. ` +
          `Fix the manifest or pass --namespace explicitly.`,
      );
    }
  }

  const serverUrl = getServerUrl(opts.serverUrl);
  let host: string;
  try {
    host = new URL(serverUrl).host;
  } catch {
    host = 'localhost';
  }
  const creds = readCredentials(host, opts.homeDir);
  if (creds?.namespace) return creds.namespace;

  return 'personal';
}

export function registerOwnershipCommand(program: Command): void {
  program
    .command('ownership')
    .description('Show file ownership scores')
    .argument('<path>', 'Repository-relative file path')
    .option('-l, --limit <n>', 'Max owners to return', '3')
    .option('-n, --namespace <namespace>', 'Namespace (default: from team.json or credentials)')
    .option('--json', 'Output as JSON')
    .option('--server-url <url>', 'Server URL (default: http://localhost:7430)')
    .option('--token <token>', 'Bearer token')
    .action(
      async (
        filePath: string,
        options: {
          limit?: string;
          namespace?: string;
          json?: boolean;
          serverUrl?: string;
          token?: string;
        },
      ) => {
        const namespace = resolveOwnershipNamespace({
          explicit: options.namespace,
          serverUrl: options.serverUrl,
        });
        const { runOwnership } = await import('../ownership.js');
        await runOwnership({
          path: filePath,
          namespace,
          limit: options.limit ? Number(options.limit) : undefined,
          json: options.json,
          serverUrl: options.serverUrl,
          token: options.token,
        });
      },
    );
}
