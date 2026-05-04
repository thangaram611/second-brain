import * as p from '@clack/prompts';
import type { Command } from 'commander';

export function registerInitResetCommands(program: Command): void {
  // --- brain reset ---
  program
    .command('reset')
    .description('Undo init: remove ~/.second-brain (with confirmation), optionally restore ~/.claude.json')
    .option('-y, --yes', 'Non-interactive: proceed without confirmation')
    .option('--wire-claude', 'Also restore ~/.claude.json from its most recent backup')
    .option('--dir <path>', 'Override brain directory (defaults to ~/.second-brain)')
    .action(async (options: { yes?: boolean; wireClaude?: boolean; dir?: string }) => {
      const { runReset } = await import('../reset.js');
      await runReset(options);
    });

  // --- brain init [<subcommand>] ---
  // No subcommand → solo init wizard (back-compat, runInit).
  // `server`     → bootstrap a team-mode server install.
  // `client`     → redeem invite + wire local repo.
  const init = program
    .command('init')
    .description('Initialize a brain — solo (no args), or `server` / `client` for team mode')
    .option('-p, --project <name>', 'Default namespace (solo mode)')
    .option('--db <path>', 'Custom database path (solo mode)')
    .option('-y, --yes', 'Non-interactive: accept defaults (solo mode)')
    .option('--wire-claude', 'Patch ~/.claude.json with the MCP server entry (solo mode)')
    .action(async (options: { project?: string; db?: string; yes?: boolean; wireClaude?: boolean }, cmd) => {
      // Only run the solo wizard when no subcommand was invoked.
      if (cmd.args.length === 0) {
        const { runInit } = await import('../init.js');
        await runInit(options);
      }
    });

  init
    .command('server')
    .description('Bootstrap a team-mode server install (writes secrets, DBs, service unit; mints admin PAT)')
    .option('--public-url <url>', 'Public URL the server is reachable at')
    .option('--namespace <name>', 'Default admin namespace')
    .option('--storage-dir <path>', 'Where to store brain.db, users.db, relay/')
    .option('--port <n>', 'API port', (v) => Number(v))
    .option('--relay-port <n>', 'Relay port', (v) => Number(v))
    .option('--admin-email <email>', 'Bootstrap admin email')
    .option('--admin-pat-ttl <ttl>', 'Bootstrap admin PAT TTL (e.g., 90d, max 365d)', '90d')
    .option('--non-interactive', 'Skip all prompts')
    .option('--force', 'Overwrite an existing install (rotates secrets; preserves DBs)')
    .action(async (options) => {
      const { runInitServer } = await import('../init-server.js');
      try {
        await runInitServer(options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  init
    .command('client')
    .description('Join a team server: redeem invite, store PAT, optionally wire repo')
    .requiredOption('--invite <token>', 'Invite token from `brain admin invite`')
    .option('--server <url>', 'Server URL (overrides BRAIN_API_URL)')
    .option('--non-interactive', 'Skip prompts; auto-wire if a manifest is present')
    .option('--no-wire', 'Skip repo wiring even when a team.json manifest is present')
    .option('--refresh', 'Replace an existing credentials file for this host')
    .action(async (options: {
      invite: string;
      server?: string;
      nonInteractive?: boolean;
      wire?: boolean;
      refresh?: boolean;
    }) => {
      const { runInitClient } = await import('../init-client.js');
      try {
        await runInitClient({
          invite: options.invite,
          serverUrl: options.server,
          nonInteractive: options.nonInteractive,
          wire: options.wire,
          refresh: options.refresh,
          shouldWire: async (root, ns) => {
            const ans = await p.confirm({
              message: `Wire ${root} into namespace '${ns}'?`,
              initialValue: true,
            });
            return ans === true;
          },
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

export function registerAdminCommand(program: Command): void {
  const admin = program
    .command('admin')
    .description('Server-admin operations (invites, token management)');

  admin
    .command('invite')
    .description('Mint a single-use invite token')
    .requiredOption('--namespace <name>', 'Namespace the invite locks the new user to')
    .option('--ttl <duration>', 'Time-to-live (e.g., 24h, 7d)', '24h')
    .option('--role <role>', 'member | admin', 'member')
    .option('--scopes <csv>', 'Comma-separated scopes (read,write,admin)', 'read,write')
    .action(async (options) => {
      const { adminInvite } = await import('../admin.js');
      try {
        const result = await adminInvite({
          namespace: options.namespace,
          ttl: options.ttl,
          role: options.role,
          scopes: options.scopes,
        });
        process.stdout.write(
          `${result.invite}\n\n  jti:        ${result.jti}\n  expires at: ${new Date(result.expiresAt).toISOString()}\n`,
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  const token = admin.command('token').description('Manage user tokens');

  token
    .command('list')
    .description('List all tokens for a user (admin only)')
    .requiredOption('--user <email>', 'Target user email')
    .action(async (options: { user: string }) => {
      const { adminTokenList } = await import('../admin.js');
      try {
        const tokens = await adminTokenList({ email: options.user });
        if (tokens.length === 0) {
          process.stdout.write('  (no tokens for that user)\n');
          return;
        }
        for (const t of tokens) {
          const status =
            t.revokedAt !== null
              ? 'revoked'
              : t.expiresAt !== null && t.expiresAt <= Date.now()
                ? 'expired'
                : 'active';
          process.stdout.write(
            `  ${t.id}  ${status.padEnd(8)}  ns=${t.namespace ?? '*'}  scopes=${t.scopes.join('+')}  label=${t.label ?? '-'}\n`,
          );
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  token
    .command('revoke <token-id>')
    .description('Revoke a token by id (admin only)')
    .action(async (tokenId: string) => {
      const { adminTokenRevoke } = await import('../admin.js');
      try {
        const ok = await adminTokenRevoke({ tokenId });
        process.stdout.write(ok ? `  revoked ${tokenId}\n` : `  no-op (${tokenId} not found or already revoked)\n`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose local install: server reach, PAT validity, manifest drift, sidecars, hooks')
    .action(async () => {
      const { runDoctor } = await import('../doctor.js');
      const result = await runDoctor();
      process.exit(result.exitCode);
    });
}
