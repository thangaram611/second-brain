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
 *      (storage-dir/users.db) so schemas are initialized.
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
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { Brain } from '@second-brain/core';
import { UsersService } from '@second-brain/server/services/users';
import { parseTtlMs } from './admin.js';
import { writeServerConfig } from './lib/server-config.js';

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
  /**
   * Linux only: system account that systemd's `User=` runs the services as.
   * REQUIRED on Linux (enforced by preflight). macOS ignores this entirely.
   */
  serviceUser?: string;
  /** Override platform detection (tests). */
  platform?: NodeJS.Platform;
  /** Override secrets-file location (tests). */
  secretsPath?: string;
  /** Override service-file location (tests). */
  serviceFilePath?: string;
  /** Override home dir (tests). */
  homeDir?: string;
  /** Override euid for the Linux preflight (tests). */
  getuid?: () => number;
  /** Override the chown / chmod shell-out (tests — no-op by default in CI). */
  execFileSync?: typeof nodeExecFileSync;
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
  relayServiceFilePath: string | null;
  serverConfigPath: string;
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

/**
 * XML-escape a string for safe embedding inside a plist `<string>` element.
 * Required because user paths may legitimately contain `&` (e.g. a temp dir
 * named `/tmp/brain&server-XXXX`) and would break the plist XML parse.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
  // single-quoted (shSingleQuote) so spaces and shell metacharacters survive,
  // AND XML-escaped (xmlEscape) so `&` / `<` / `>` in the resulting string
  // don't break the plist XML parse. Both transforms are necessary.
  const shellSecrets = xmlEscape(shSingleQuote(args.secretsPath));
  const shellNode = xmlEscape(shSingleQuote(args.nodeBin));
  const shellEntry = xmlEscape(shSingleQuote(`${args.installDir}/apps/server/dist/index.mjs`));
  const xInstallDir = xmlEscape(args.installDir);
  const xStorageDir = xmlEscape(args.storageDir);
  const xPublicUrl = xmlEscape(args.publicUrl);
  const xLogDir = xmlEscape(logDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Second Brain server (macOS launchd agent).
  Written by \`brain init server\`. Secrets live in ${xmlEscape(args.secretsPath)} (mode 0600);
  this plist deliberately omits EnvironmentVariables for sensitive values — a
  small shell wrapper sources the env file at startup.
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
    <string>set -a; . ${shellSecrets}; set +a; exec ${shellNode} ${shellEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xInstallDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>BRAIN_AUTH_MODE</key>
    <string>pat</string>
    <key>BRAIN_DB_PATH</key>
    <string>${xStorageDir}/brain.db</string>
    <key>BRAIN_USERS_DB_PATH</key>
    <string>${xStorageDir}/users.db</string>
    <key>BRAIN_API_PORT</key>
    <string>${args.port}</string>
    <key>BRAIN_PUBLIC_URL</key>
    <string>${xPublicUrl}</string>
    <key>RELAY_PORT</key>
    <string>${args.relayPort}</string>
    <key>RELAY_PERSIST_DIR</key>
    <string>${xStorageDir}/relay</string>
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
  <string>${xLogDir}/server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${xLogDir}/server.err.log</string>
</dict>
</plist>
`;
}

/** Hocuspocus CRDT relay — Tier-1 hardened systemd unit, mirrors the server unit. */
export function renderRelaySystemdUnit(args: {
  user: string;
  storageDir: string;
  installDir: string;
  nodeBin: string;
  secretsPath: string;
  relayPort: number;
}): string {
  return `# Second Brain — Yjs CRDT relay (Hocuspocus).
# Written by \`brain init server\`. Edit at your own risk; \`brain init server --force\`
# will rewrite this file.

[Unit]
Description=Second Brain Yjs CRDT relay
Documentation=https://github.com/second-brain/second-brain
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${args.user}
Group=${args.user}
WorkingDirectory=${args.installDir}

# Loaded BEFORE ExecStart. Mode 0640, root:${args.user}. Carries RELAY_AUTH_SECRET.
EnvironmentFile=${args.secretsPath}
Environment=RELAY_PORT=${args.relayPort}
Environment=RELAY_PERSIST_DIR=${args.storageDir}/relay

ExecStart=${args.nodeBin} ${args.installDir}/apps/relay/dist/index.mjs

# Restart policy
Restart=on-failure
RestartSec=5s
StartLimitBurst=5
StartLimitIntervalSec=60

StandardOutput=journal
StandardError=journal
SyslogIdentifier=second-brain-relay

# Tier-1 hardening (mirrors the server unit verbatim).
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

/** Hocuspocus CRDT relay — macOS launchd plist, mirrors the server plist. */
export function renderRelayLaunchdPlist(args: {
  installDir: string;
  nodeBin: string;
  secretsPath: string;
  storageDir: string;
  relayPort: number;
}): string {
  const logDir = path.join(args.storageDir, 'logs');
  const shellSecrets = xmlEscape(shSingleQuote(args.secretsPath));
  const shellNode = xmlEscape(shSingleQuote(args.nodeBin));
  const shellEntry = xmlEscape(shSingleQuote(`${args.installDir}/apps/relay/dist/index.mjs`));
  const xInstallDir = xmlEscape(args.installDir);
  const xStorageDir = xmlEscape(args.storageDir);
  const xLogDir = xmlEscape(logDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Second Brain relay (macOS launchd agent).
  Written by \`brain init server\`. Sources RELAY_AUTH_SECRET from
  ${xmlEscape(args.secretsPath)} (mode 0600) via the same shell wrapper as the server.
-->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.secondbrain.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; . ${shellSecrets}; set +a; exec ${shellNode} ${shellEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xInstallDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>RELAY_PORT</key>
    <string>${args.relayPort}</string>
    <key>RELAY_PERSIST_DIR</key>
    <string>${xStorageDir}/relay</string>
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
  <string>${xLogDir}/relay.out.log</string>
  <key>StandardErrorPath</key>
  <string>${xLogDir}/relay.err.log</string>
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
  const execFileSync = options.execFileSync ?? nodeExecFileSync;

  // Linux preflight (gates everything else). Linux has exactly one supported
  // invocation: `sudo brain init server --service-user <name> …`. Every other
  // invocation errors with a specific remedy. macOS bypasses this — its
  // defaults all live under $HOME and don't need root.
  if (platform === 'linux') {
    const getuid = options.getuid ?? process.getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : -1;
    const isRoot = uid === 0;
    if (!isRoot) {
      throw new Error(
        'Linux: `brain init server` writes to /etc/systemd/system, /etc/second-brain, and ' +
          '/var/lib/second-brain — all of which require root. Re-run with `sudo brain init server ' +
          '--service-user <name> ...`.',
      );
    }
    if (!options.serviceUser) {
      throw new Error(
        "Linux: `--service-user <name>` is required so the systemd unit's `User=` does not run " +
          'the service as root. Pass the name of an existing system account, e.g. ' +
          '`--service-user secondbrain` (create the account first with ' +
          '`useradd --system --no-create-home --shell /usr/sbin/nologin secondbrain`).',
      );
    }
  }

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

  // 2. Initialize schemas by opening + closing each DB.
  const brain = new Brain({ path: brainDbPath });
  brain.close();
  const usersSvc = new UsersService({ path: usersDbPath });

  // 3. Bootstrap admin user (idempotent — upserts by email).
  const adminUser = usersSvc.upsertUser({ email: adminEmail, role: 'admin' });
  // Guard the membership write — without `if`, an init call that omits
  // `--namespace` would write a NULL into user_namespaces.namespace and
  // poison every later hasNamespaceMembership() check for that user.
  if (options.namespace) {
    usersSvc.addNamespaceMembership({
      userId: adminUser.id,
      namespace: options.namespace,
      role: 'admin',
    });
  }
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

  // 5. Render service files (server + relay).
  const installDir = detectInstallDir();
  const nodeBin = detectNodeBin();
  // On Linux, preflight has already required `serviceUser`. On macOS, fall
  // back to the SUDO_USER / USER chain (we never run as root there).
  const user = options.serviceUser ?? process.env.SUDO_USER ?? process.env.USER ?? 'second-brain';
  let serviceKind: InitServerResult['serviceKind'] = 'manual';
  let relayServiceFilePath: string | null = null;
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
    relayServiceFilePath = path.join(path.dirname(serviceFilePath), 'second-brain-relay.service');
    const relayUnit = renderRelaySystemdUnit({
      user,
      storageDir,
      installDir,
      nodeBin,
      secretsPath,
      relayPort,
    });
    fs.writeFileSync(relayServiceFilePath, relayUnit, 'utf8');
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
    relayServiceFilePath = path.join(path.dirname(serviceFilePath), 'dev.secondbrain.relay.plist');
    const relayPlist = renderRelayLaunchdPlist({
      installDir,
      nodeBin,
      secretsPath,
      storageDir,
      relayPort,
    });
    fs.writeFileSync(relayServiceFilePath, relayPlist, 'utf8');
    serviceKind = 'launchd';
  }

  // 6. Linux ownership — preflight already required root + service-user.
  // Storage + relay persist dir become user-owned (writable at runtime).
  // secrets.env stays root-owned but group-readable by the service user.
  // Unit files in /etc/systemd/system stay root-owned (default).
  if (platform === 'linux') {
    execFileSync('chown', ['-R', `${user}:${user}`, storageDir]);
    execFileSync('chown', [`root:${user}`, secretsPath]);
    execFileSync('chmod', ['0640', secretsPath]);
  }

  // 7. Write discoverable server.json so `brain doctor` can find ports + paths.
  // Always at $HOME/.second-brain/server.json regardless of --storage-dir.
  writeServerConfig(home, {
    apiPort: port,
    relayPort,
    publicUrl,
    storageDir,
    secretsPath,
    serviceFilePath: serviceKind === 'manual' ? null : serviceFilePath,
    relayServiceFilePath,
  });
  const serverConfigJsonPath = path.join(home, '.second-brain', 'server.json');

  // 8. Print summary.
  const expiresIso = new Date(expiresAt).toISOString();
  const quote = shSingleQuote;
  const lines = [
    '✓ second-brain server initialized',
    '',
    `  storage dir:    ${storageDir}`,
    `  secrets file:   ${secretsPath}  (mode 0600)`,
    `  brain.db:       ${brainDbPath}`,
    `  users.db:       ${usersDbPath}`,
    `  relay persist:  ${relayPersistDir}`,
    `  server config:  ${serverConfigJsonPath}`,
  ];
  if (serviceKind === 'systemd') {
    lines.push(`  systemd unit:   ${serviceFilePath}`);
    lines.push(`  relay unit:     ${relayServiceFilePath}`);
    lines.push('', '  Activate:');
    lines.push('    sudo systemctl daemon-reload');
    lines.push('    sudo systemctl enable --now second-brain-server');
    lines.push('    sudo systemctl enable --now second-brain-relay');
  } else if (serviceKind === 'launchd') {
    lines.push(`  launchd plist:  ${serviceFilePath}`);
    lines.push(`  relay plist:    ${relayServiceFilePath}`);
    lines.push('', '  Activate:');
    lines.push(`    launchctl load ${serviceFilePath}`);
    lines.push(`    launchctl load ${relayServiceFilePath}`);
  } else {
    lines.push('', '  No service file written for this platform — start manually:');
    lines.push('', '  # Server (one shell):');
    lines.push(`    set -a; . ${quote(secretsPath)}; set +a; \\`);
    lines.push(`    BRAIN_AUTH_MODE=pat \\`);
    lines.push(`    BRAIN_DB_PATH=${quote(brainDbPath)} \\`);
    lines.push(`    BRAIN_USERS_DB_PATH=${quote(usersDbPath)} \\`);
    lines.push(`    BRAIN_API_PORT=${port} \\`);
    lines.push(`    BRAIN_PUBLIC_URL=${quote(publicUrl)} \\`);
    lines.push(`    ${quote(nodeBin)} ${quote(`${installDir}/apps/server/dist/index.mjs`)}`);
    lines.push('', '  # Relay (another shell):');
    lines.push(`    set -a; . ${quote(secretsPath)}; set +a; \\`);
    lines.push(`    RELAY_PORT=${relayPort} \\`);
    lines.push(`    RELAY_PERSIST_DIR=${quote(`${storageDir}/relay`)} \\`);
    lines.push(`    ${quote(nodeBin)} ${quote(`${installDir}/apps/relay/dist/index.mjs`)}`);
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
    `    brain admin invite --namespace ${options.namespace ?? '<team>'} --role member --ttl 24h`,
    '',
    '  Sync onboarding: clients run `brain sync join` with just their invite PAT.',
    '  The server mints the relay token itself, so RELAY_AUTH_SECRET never leaves',
    '  this host — do NOT share it. Clients only need the relay URL (via team.json',
    '  server.relayUrl, or `brain sync join --relay`):',
    `    Relay URL: ws://${publicHostname(publicUrl)}:${relayPort}`,
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
    relayServiceFilePath,
    serverConfigPath: serverConfigJsonPath,
    serviceKind,
    adminPat: minted.pat,
    adminTokenId: minted.tokenId,
    adminEmail,
    adminExpiresAt: expiresIso,
    rotatedSecrets: existingSecrets,
  };
}

/** Extract `hostname[:port]` → just hostname, for the sync-URL hint. */
function publicHostname(publicUrl: string): string {
  try {
    return new URL(publicUrl).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}
