import type { Command } from 'commander';
import * as os from 'node:os';
import { getServerUrl } from '../lib/config.js';

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
  error: string | null;
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
    error: getStringOrNull(raw, 'error'),
  };
}

export function registerSyncCommand(program: Command): void {
  const SERVER_URL = getServerUrl();

  const syncCmd = program
    .command('sync')
    .description('Team sync management');

  // brain sync join --namespace <ns> --relay <url> [--secret <secret>]
  syncCmd
    .command('join')
    .description('Join a sync room for a project namespace')
    .requiredOption('--namespace <namespace>', 'Project namespace to sync')
    .requiredOption('--relay <url>', 'Relay server WebSocket URL')
    .option('--secret <secret>', 'Shared secret for relay auth (or set RELAY_AUTH_SECRET)')
    .action(async (options: { namespace: string; relay: string; secret?: string }) => {
      const secret = options.secret ?? process.env.RELAY_AUTH_SECRET;
      if (!secret) {
        console.error('Error: --secret or RELAY_AUTH_SECRET required');
        process.exit(1);
      }

      if (options.namespace === 'personal') {
        console.error('Error: Cannot sync the personal namespace');
        process.exit(1);
      }

      try {
        // Step 1: Get auth token from relay
        const relayHttpUrl = options.relay.replace(/^ws/, 'http');
        const tokenRes = await fetch(`${relayHttpUrl}/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            namespace: options.namespace,
            userName: os.userInfo().username,
            secret,
          }),
        });

        if (!tokenRes.ok) {
          const err: unknown = await tokenRes.json().catch(() => ({ error: 'Auth failed' }));
          const message = isRecord(err) && typeof err.error === 'string'
            ? err.error
            : tokenRes.statusText;
          console.error(`Failed to authenticate with relay: ${message}`);
          process.exit(1);
        }

        const tokenBody: unknown = await tokenRes.json();
        if (!isRecord(tokenBody) || typeof tokenBody.token !== 'string') {
          console.error('Invalid token response from relay');
          process.exit(1);
        }
        const { token } = tokenBody;

        // Step 2: Tell the server to join sync
        const joinRes = await fetch(`${SERVER_URL}/api/sync/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            namespace: options.namespace,
            relayUrl: options.relay,
            token,
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
        console.log(`Joined sync for namespace "${options.namespace}"`);
        console.log(`  State: ${status.state}`);
        console.log(`  Relay: ${options.relay}`);
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
        const res = await fetch(`${SERVER_URL}/api/sync/status`);
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
          if (s.error) {
            console.log(`    Error: ${s.error}`);
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
        const res = await fetch(`${SERVER_URL}/api/sync/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
