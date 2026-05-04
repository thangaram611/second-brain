/**
 * `brain init server` (PR4 §C).
 *
 *   brain init server
 *     [--public-url ...]
 *     [--namespace ...]
 *     [--storage-dir /var/lib/second-brain]
 *     [--port 7430]
 *     [--relay-port 7421]
 *     [--admin-email a@b.test]
 *     [--admin-pat-ttl 90d]    (max 365d per OWASP ASVS 5.0 §3.3)
 *     [--non-interactive]
 *     [--force]
 *
 * Steps:
 *   1. Generate three 32-byte base64url signing secrets if absent.
 *   2. Write `secrets.env` mode 0600 to /etc/second-brain (Linux) or
 *      ~/.second-brain (macOS / fallback). Refuse to overwrite without --force.
 *   3. Open + close Brain (storage-dir/brain.db) and UsersService
 *      (storage-dir/users.db) so migrations apply.
 *   4. Render the systemd unit (Linux) or launchd plist (macOS) with the
 *      Tier-1 hardening directives from the plan.
 *   5. Mint a bootstrap admin PAT (default 90d expiry).
 *
 * Idempotent — re-run on a populated install detects existing artifacts and
 * exits 1 unless `--force` is set. `--force` rotates secrets but does NOT
 * drop the SQLite databases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Brain } from '@second-brain/core';
import { UsersService } from '@second-brain/server/services/users';
import { parseTtlMs } from './admin.js';

export interface InitServerOptions {
  publicUrl?: string;
  namespace?: string;
  storageDir?: string;
  port?: number;
  relayPort?: number;
  adminEmail?: string;
  adminPatTtl?: string;
  nonInteractive?: boolean;
  force?: boolean;
  /** Override platform detection (tests). */
  platform?: NodeJS.Platform;
  /** Override secrets-file location (tests). */
  secretsPath?: string;
  /** Override service-file location (tests). */
  serviceFilePath?: string;
  /** Override home dir (tests). */
  homeDir?: string;
  /** Stream destination for human-facing output (tests). */
  stdout?: { write(s: string): void };
}

export interface InitServerResult {
  storageDir: string;
  secretsPath: string;
  brainDbPath: string;
  usersDbPath: string;
  relayPersistDir: string;
  serviceFilePath: string | null;
  serviceKind: 'systemd' | 'launchd' | 'manual';
  adminPat: string;
  adminTokenId: string;
  adminEmail: string;
  adminExpiresAt: string;
  rotatedSecrets: boolean;
}

const MAX_PAT_TTL_MS = 365 * 86_400_000;
const DEFAULT_PAT_TTL_MS = 90 * 86_400_000;

const SYSTEMD_DEFAULT_PATH = '/etc/systemd/system/second-brain-server.service';
const SYSTEMD_DEFAULT_SECRETS = '/etc/second-brain/secrets.env';

function defaultStorageDir(platform: NodeJS.Platform, home: string): string {
  return platform === 'linux'
    ? '/var/lib/second-brain'
    : path.join(home, '.second-brain', 'data');
}

function defaultSecretsPath(platform: NodeJS.Platform, home: string): string {
  return platform === 'linux'
    ? SYSTEMD_DEFAULT_SECRETS
    : path.join(home, '.second-brain', 'secrets.env');
}

function defaultServicePath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'linux') return SYSTEMD_DEFAULT_PATH;
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'LaunchAgents', 'dev.secondbrain.server.plist');
  }
  return null;
}

/** 32 random bytes → base64url (no padding). 256-bit entropy per secret. */
function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

interface SecretsBundle {
  BRAIN_SERVER_SIGNING_KEY: string;
  BRAIN_INVITE_SIGNING_KEY: string;
  RELAY_AUTH_SECRET: string;
}

function renderSecretsEnv(secrets: SecretsBundle): string {
  return [
    '# Second Brain server secrets — written by `brain init server`.',
    '# File mode is 0600. Do NOT commit; do NOT email; rotate with `brain init server --force`.',
    `BRAIN_SERVER_SIGNING_KEY=${secrets.BRAIN_SERVER_SIGNING_KEY}`,
    `BRAIN_INVITE_SIGNING_KEY=${secrets.BRAIN_INVITE_SIGNING_KEY}`,
    `RELAY_AUTH_SECRET=${secrets.RELAY_AUTH_SECRET}`,
    '',
  ].join('\n');
}

function writeSecretsAtomic(target: string, contents: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  // tmp + target share a directory → renameSync cannot fail with EXDEV. If
  // rename does fail it's a real fault; surface it rather than rewriting
  // target in-place under its previous mode (would leak secrets through a
  // stale file mode in the rename-fail path).
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore tmp cleanup */
    }
    throw err;
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Tier-1 hardened systemd unit (per plan §L). MemoryDenyWriteExecute=no for V8 JIT. */
export function renderSystemdUnit(args: {
  user: string;
  storageDir: string;
  installDir: string;
  nodeBin: string;
  secretsPath: string;
  port: number;
  relayPort: number;
  publicUrl: string;
}): string {
  return `# Second Brain — REST API + WebSocket server.
# Written by \`brain init server\`. Edit at your own risk; \`brain init server --force\`
# will rewrite this file (secrets and DBs are preserved).

[Unit]
Description=Second Brain API server
Documentation=https://github.com/second-brain/second-brain
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${args.user}
Group=${args.user}
WorkingDirectory=${args.installDir}

# Loaded BEFORE ExecStart. Mode 0600, owner-only.
EnvironmentFile=${args.secretsPath}
Environment=BRAIN_AUTH_MODE=pat
Environment=BRAIN_DB_PATH=${args.storageDir}/brain.db
Environment=BRAIN_USERS_DB_PATH=${args.storageDir}/users.db
Environment=BRAIN_API_PORT=${args.port}
Environment=BRAIN_PUBLIC_URL=${args.publicUrl}
Environment=RELAY_PORT=${args.relayPort}
Environment=RELAY_PERSIST_DIR=${args.storageDir}/relay

ExecStart=${args.nodeBin} ${args.installDir}/apps/server/dist/index.mjs

# Restart policy
Restart=on-failure
RestartSec=5s
StartLimitBurst=5
StartLimitIntervalSec=60

StandardOutput=journal
StandardError=journal
SyslogIdentifier=second-brain-server

# Tier-1 hardening (verified 2026-05; \`systemd-analyze security\` target < 3.0).
# IMPORTANT: V8's JIT requires W+X — DO NOT set MemoryDenyWriteExecute=yes.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallFilter=@system-service
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
MemoryDenyWriteExecute=no

ReadWritePaths=${args.storageDir}
StateDirectory=second-brain

# Resource limits
LimitNOFILE=65535
MemoryHigh=512M
MemoryMax=1G
OOMPolicy=stop

[Install]
WantedBy=multi-user.target
`;
}

/** Single-quote a string for safe embedding in a POSIX shell as a literal. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** macOS launchd plist with hardened defaults — KeepAlive dict, no EnvironmentVariables for secrets. */
export function renderLaunchdPlist(args: {
  installDir: string;
  nodeBin: string;
  secretsPath: string;
  storageDir: string;
  port: number;
  relayPort: number;
  publicUrl: string;
}): string {
  const logDir = path.join(args.storageDir, 'logs');
  // The /bin/sh -c body is a shell command — every interpolated path MUST be
  // single-quoted, otherwise spaces or shell metacharacters in a user's
  // install / Homebrew node / data dir break service startup. Plist string
  // values themselves don't need shell-escaping (the launchd plist parser is
  // XML, not shell), but they DO need XML-escaping if a path contained
  // `<`/`>`/`&`/`"` — exceedingly unlikely in a filesystem path, but we
  // pass them through as-is and document the constraint.
  const shimSecrets = shSingleQuote(args.secretsPath);
  const shimNode = shSingleQuote(args.nodeBin);
  const shimEntry = shSingleQuote(`${args.installDir}/apps/server/dist/index.mjs`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Second Brain server (macOS launchd agent).
  Written by \`brain init server\`. Secrets live in ${args.secretsPath} (mode 0600);
  this plist deliberately omits EnvironmentVariables for sensitive values — a
  small shim sources the env file at startup.
-->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.secondbrain.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; . ${shimSecrets}; set +a; exec ${shimNode} ${shimEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${args.installDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>BRAIN_AUTH_MODE</key>
    <string>pat</string>
    <key>BRAIN_DB_PATH</key>
    <string>${args.storageDir}/brain.db</string>
    <key>BRAIN_USERS_DB_PATH</key>
    <string>${args.storageDir}/users.db</string>
    <key>BRAIN_API_PORT</key>
    <string>${args.port}</string>
    <key>BRAIN_PUBLIC_URL</key>
    <string>${args.publicUrl}</string>
    <key>RELAY_PORT</key>
    <string>${args.relayPort}</string>
    <key>RELAY_PERSIST_DIR</key>
    <string>${args.storageDir}/relay</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>4096</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logDir}/server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/server.err.log</string>
</dict>
</plist>
`;
}

function detectInstallDir(): string {
  // Walk up from this file's location until we find a `pnpm-workspace.yaml`.
  let dir = path.resolve(import.meta.dirname ?? __dirname);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function detectNodeBin(): string {
  return process.execPath;
}

export async function runInitServer(options: InitServerOptions = {}): Promise<InitServerResult> {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? os.homedir();
  const stdout = options.stdout ?? process.stdout;

  const storageDir = options.storageDir ?? defaultStorageDir(platform, home);
  const secretsPath = options.secretsPath ?? defaultSecretsPath(platform, home);
  const serviceFilePath = options.serviceFilePath ?? defaultServicePath(platform, home);
  const port = options.port ?? 7430;
  const relayPort = options.relayPort ?? 7421;
  const publicUrl = options.publicUrl ?? `http://localhost:${port}`;
  const adminEmail = options.adminEmail ?? `admin@${platform === 'darwin' ? 'localhost.local' : 'second-brain.local'}`;
  const ttlMs = options.adminPatTtl ? parseTtlMs(options.adminPatTtl) : DEFAULT_PAT_TTL_MS;
  if (ttlMs > MAX_PAT_TTL_MS) {
    throw new Error(
      `--admin-pat-ttl exceeds the 365-day OWASP ASVS 5.0 ceiling (${ttlMs}ms > ${MAX_PAT_TTL_MS}ms)`,
    );
  }

  // 0. Idempotency guard — bail out unless --force.
  const existingSecrets = fs.existsSync(secretsPath);
  if (existingSecrets && !options.force) {
    throw new Error(
      `already initialized: ${secretsPath} exists. Pass --force to rotate secrets (DBs preserved).`,
    );
  }

  // 1. Storage layout.
  fs.mkdirSync(storageDir, { recursive: true });
  const brainDbPath = path.join(storageDir, 'brain.db');
  const usersDbPath = path.join(storageDir, 'users.db');
  const relayPersistDir = path.join(storageDir, 'relay');
  fs.mkdirSync(relayPersistDir, { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'logs'), { recursive: true });

  // 2. Apply migrations by opening + closing each DB.
  const brain = new Brain({ path: brainDbPath });
  brain.close();
  const usersSvc = new UsersService({ path: usersDbPath });

  // 3. Bootstrap admin user (idempotent — upserts by email).
  const adminUser = usersSvc.upsertUser({ email: adminEmail, role: 'admin' });
  // Admin gets a NULL-namespace token by default — reaches every namespace.
  const expiresAt = Date.now() + ttlMs;
  const minted = await usersSvc.mintPat({
    userId: adminUser.id,
    label: 'bootstrap-admin',
    scopes: ['admin'],
    namespace: null,
    expiresAt,
  });
  usersSvc.close();

  // 4. Generate + write secrets.
  const secrets: SecretsBundle = {
    BRAIN_SERVER_SIGNING_KEY: generateSecret(),
    BRAIN_INVITE_SIGNING_KEY: generateSecret(),
    RELAY_AUTH_SECRET: generateSecret(),
  };
  writeSecretsAtomic(secretsPath, renderSecretsEnv(secrets));

  // 5. Render service file.
  const installDir = detectInstallDir();
  const nodeBin = detectNodeBin();
  const user = process.env.SUDO_USER ?? process.env.USER ?? 'second-brain';
  let serviceKind: InitServerResult['serviceKind'] = 'manual';
  if (serviceFilePath && platform === 'linux') {
    const unit = renderSystemdUnit({
      user,
      storageDir,
      installDir,
      nodeBin,
      secretsPath,
      port,
      relayPort,
      publicUrl,
    });
    fs.mkdirSync(path.dirname(serviceFilePath), { recursive: true });
    fs.writeFileSync(serviceFilePath, unit, 'utf8');
    serviceKind = 'systemd';
  } else if (serviceFilePath && platform === 'darwin') {
    const plist = renderLaunchdPlist({
      installDir,
      nodeBin,
      secretsPath,
      storageDir,
      port,
      relayPort,
      publicUrl,
    });
    fs.mkdirSync(path.dirname(serviceFilePath), { recursive: true });
    fs.writeFileSync(serviceFilePath, plist, 'utf8');
    serviceKind = 'launchd';
  }

  // 6. Print summary.
  const expiresIso = new Date(expiresAt).toISOString();
  const lines = [
    '✓ second-brain server initialized',
    '',
    `  storage dir:    ${storageDir}`,
    `  secrets file:   ${secretsPath}  (mode 0600)`,
    `  brain.db:       ${brainDbPath}`,
    `  users.db:       ${usersDbPath}`,
    `  relay persist:  ${relayPersistDir}`,
  ];
  if (serviceKind === 'systemd') {
    lines.push(`  systemd unit:   ${serviceFilePath}`);
    lines.push('', '  Activate:');
    lines.push('    sudo systemctl daemon-reload');
    lines.push('    sudo systemctl enable --now second-brain-server');
  } else if (serviceKind === 'launchd') {
    lines.push(`  launchd plist:  ${serviceFilePath}`);
    lines.push('', '  Activate:');
    lines.push(`    launchctl load ${serviceFilePath}`);
  } else {
    lines.push('', '  No service file written for this platform — start manually:');
    lines.push(`    set -a; . ${secretsPath}; set +a; ${nodeBin} ${installDir}/apps/server/dist/index.mjs`);
  }
  lines.push(
    '',
    '  Bootstrap admin PAT (one-time — copy now; not recoverable):',
    `    email:      ${adminEmail}`,
    `    token id:   ${minted.tokenId}`,
    `    PAT:        ${minted.pat}`,
    `    expires:    ${expiresIso}`,
    '',
    '  Next:',
    '    export BRAIN_AUTH_TOKEN=' + minted.pat,
    '    brain admin invite --namespace <team> --role member --ttl 24h',
    '',
  );
  stdout.write(lines.join('\n'));

  return {
    storageDir,
    secretsPath,
    brainDbPath,
    usersDbPath,
    relayPersistDir,
    serviceFilePath: serviceKind === 'manual' ? null : serviceFilePath,
    serviceKind,
    adminPat: minted.pat,
    adminTokenId: minted.tokenId,
    adminEmail,
    adminExpiresAt: expiresIso,
    rotatedSecrets: existingSecrets,
  };
}
