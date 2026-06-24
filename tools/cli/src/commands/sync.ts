import type { Command } from 'commander';
import { getServerUrl, buildAuthHeadersAsync } from '../lib/config.js';
import { gitRepoRoot } from '../lib/repo.js';
import { loadTeamManifest } from '../team-manifest.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string') {
    throw new Error(`Expected string for "${key}", got ${typeof val}`);
  }
  return val;
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number for "${key}", got ${typeof val}`);
  }
  return val;
}

function getStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') {
    throw new Error(`Expected string or null for "${key}", got ${typeof val}`);
  }
  return val;
}

interface SyncStatus {
  namespace: string;
  state: string;
  connectedPeers: number;
  lastSyncedAt: string | null;
}

function parseSyncStatus(raw: unknown): SyncStatus {
  if (!isRecord(raw)) {
    throw new Error('Expected object for sync status');
  }
  return {
    namespace: getString(raw, 'namespace'),
    state: getString(raw, 'state'),
    connectedPeers: getNumber(raw, 'connectedPeers'),
    lastSyncedAt: getStringOrNull(raw, 'lastSyncedAt'),
  };
}

export interface ResolveSyncJoinConfigOptions {
  /** Explicit `--namespace` flag, if the user passed one. */
  namespace?: string;
  /** Explicit `--relay` flag, if the user passed one. */
  relay?: string;
  /** Directory to start the git-root search from (defaults to `process.cwd()`). */
  cwd?: string;
}

export interface ResolvedSyncJoinConfig {
  namespace: string;
  relay: string;
}

/**
 * Resolve the namespace + relay URL for `brain sync join`.
 *
 * Precedence: explicit flag, then `.second-brain/team.json` (`namespace` /
 * `server.relayUrl`). There is no client secret — the server mints the relay
 * token itself (it holds `RELAY_AUTH_SECRET`), so the client only needs to know
 * which room to join and where the relay is.
 *
 * Mirrors `resolveOwnershipNamespace()`: when the manifest is the only available
 * source for a missing value but is present-and-broken (`unreadable` /
 * `invalid-json` / `invalid-schema`), throw rather than guessing. A genuinely
 * absent manifest (`not-found`) is the legitimate solo path and falls through to
 * the missing-value errors below. Fully-explicit invocations never touch the
 * manifest, so they don't depend on cwd or a readable `team.json`.
 */
export function resolveSyncJoinConfig(
  options: ResolveSyncJoinConfigOptions,
): ResolvedSyncJoinConfig {
  let namespace = options.namespace;
  let relay = options.relay;

  if (!namespace || !relay) {
    const repoRoot = gitRepoRoot({ cwd: options.cwd ?? process.cwd() });
    if (repoRoot) {
      const loaded = loadTeamManifest(repoRoot);
      if (loaded.ok) {
        namespace = namespace ?? loaded.manifest.namespace;
        relay = relay ?? loaded.manifest.server.relayUrl;
      } else if (loaded.reason !== 'not-found') {
        const detail = loaded.detail ? `: ${loaded.detail}` : '';
        throw new Error(
          `team manifest at ${loaded.absPath} is ${loaded.reason}${detail}. ` +
            `Refusing to guess sync config from a broken manifest. ` +
            `Fix the manifest or pass --namespace and --relay explicitly.`,
        );
      }
    }
  }

  if (!namespace) {
    throw new Error(
      '--namespace is required when no team manifest namespace is available',
    );
  }
  if (!relay) {
    throw new Error(
      '--relay is required when no team manifest server.relayUrl is available',
    );
  }
  if (namespace === 'personal') {
    throw new Error('Cannot sync the personal namespace');
  }

  return { namespace, relay };
}

export function registerSyncCommand(program: Command): void {
  const SERVER_URL = getServerUrl();

  const syncCmd = program
    .command('sync')
    .description('Team sync management');

  // brain sync join [--namespace <ns>] [--relay <url>]
  syncCmd
    .command('join')
    .description('Join a sync room for a project namespace')
    .option(
      '--namespace <namespace>',
      'Project namespace to sync (default: team.json namespace)',
    )
    .option(
      '--relay <url>',
      'Relay server WebSocket URL (default: team.json server.relayUrl)',
    )
    .action(async (options: { namespace?: string; relay?: string }) => {
      try {
        const resolved = resolveSyncJoinConfig({
          namespace: options.namespace,
          relay: options.relay,
        });

        // Tell the server to join sync. The server mints the relay token itself
        // (it holds RELAY_AUTH_SECRET), so the client never handles the secret —
        // it just needs to be authenticated to the server (PAT/session).
        const joinHeaders = {
          ...(await buildAuthHeadersAsync()),
          'Content-Type': 'application/json',
        };
        const joinRes = await fetch(`${SERVER_URL}/api/sync/join`, {
          method: 'POST',
          headers: joinHeaders,
          body: JSON.stringify({
            namespace: resolved.namespace,
            relayUrl: resolved.relay,
          }),
        });

        if (!joinRes.ok) {
          const err: unknown = await joinRes.json().catch(() => ({ error: 'Join failed' }));
          const message = isRecord(err) && typeof err.error === 'string'
            ? err.error
            : joinRes.statusText;
          console.error(`Failed to join sync: ${message}`);
          process.exit(1);
        }

        const status = parseSyncStatus(await joinRes.json());
        console.log(`Joined sync for namespace "${resolved.namespace}"`);
        console.log(`  State: ${status.state}`);
        console.log(`  Relay: ${resolved.relay}`);
        console.log(`  Peers: ${status.connectedPeers}`);
      } catch (err) {
        if (err instanceof Error) {
          console.error(`Error: ${err.message}`);
        }
        process.exit(1);
      }
    });

  // brain sync status
  syncCmd
    .command('status')
    .description('Show sync status for all synced namespaces')
    .action(async () => {
      try {
        const statusHeaders = await buildAuthHeadersAsync();
        const res = await fetch(`${SERVER_URL}/api/sync/status`, {
          headers: statusHeaders,
        });
        if (!res.ok) {
          console.error('Failed to fetch sync status. Is the server running?');
          process.exit(1);
        }

        const raw: unknown = await res.json();
        if (!Array.isArray(raw)) {
          console.error('Invalid sync status response');
          process.exit(1);
        }
        const statuses = raw.map(parseSyncStatus);

        if (statuses.length === 0) {
          console.log('No synced namespaces.');
          return;
        }

        console.log('Sync status:\n');
        for (const s of statuses) {
          const stateIcon = s.state === 'connected' ? '●' : s.state === 'disconnected' ? '○' : '◐';
          console.log(`  ${stateIcon} ${s.namespace}`);
          console.log(`    State: ${s.state}`);
          console.log(`    Peers: ${s.connectedPeers}`);
          if (s.lastSyncedAt) {
            console.log(`    Last synced: ${s.lastSyncedAt}`);
          }
          console.log();
        }
      } catch {
        console.error('Failed to connect to server. Is it running?');
        process.exit(1);
      }
    });

  // brain sync leave --namespace <ns>
  syncCmd
    .command('leave')
    .description('Leave a sync room')
    .requiredOption('--namespace <namespace>', 'Namespace to stop syncing')
    .action(async (options: { namespace: string }) => {
      try {
        const leaveHeaders = {
          ...(await buildAuthHeadersAsync()),
          'Content-Type': 'application/json',
        };
        const res = await fetch(`${SERVER_URL}/api/sync/leave`, {
          method: 'POST',
          headers: leaveHeaders,
          body: JSON.stringify({ namespace: options.namespace }),
        });

        if (!res.ok) {
          const err: unknown = await res.json().catch(() => ({ error: 'Leave failed' }));
          const message = isRecord(err) && typeof err.error === 'string'
            ? err.error
            : res.statusText;
          console.error(`Failed to leave sync: ${message}`);
          process.exit(1);
        }

        console.log(`Left sync for namespace "${options.namespace}"`);
      } catch {
        console.error('Failed to connect to server. Is it running?');
        process.exit(1);
      }
    });
}
