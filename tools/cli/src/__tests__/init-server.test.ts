import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runInitServer, renderSystemdUnit, renderLaunchdPlist } from '../init-server.js';

let tmp: string;
let stdoutBuf: string;
const sinkStdout = { write: (s: string): void => { stdoutBuf += s; } };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-server-'));
  stdoutBuf = '';
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tmpPath(...parts: string[]): string {
  return path.join(tmp, ...parts);
}

describe('runInitServer (Linux/systemd)', () => {
  it('on a fresh dir: writes secrets 0600, creates DBs, writes systemd unit, mints admin PAT', async () => {
    const result = await runInitServer({
      platform: 'linux',
      storageDir: tmpPath('storage'),
      secretsPath: tmpPath('etc/second-brain/secrets.env'),
      serviceFilePath: tmpPath('etc/systemd/system/second-brain-server.service'),
      adminEmail: 'admin@example.com',
      nonInteractive: true,
      stdout: sinkStdout,
    });

    // Secrets file: present + mode 0600.
    expect(fs.existsSync(result.secretsPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.secretsPath).mode & 0o777).toBe(0o600);
    }
    const secretContents = fs.readFileSync(result.secretsPath, 'utf8');
    expect(secretContents).toMatch(/BRAIN_SERVER_SIGNING_KEY=\S{40,}/);
    expect(secretContents).toMatch(/BRAIN_INVITE_SIGNING_KEY=\S{40,}/);
    expect(secretContents).toMatch(/RELAY_AUTH_SECRET=\S{40,}/);

    // DB files exist.
    expect(fs.existsSync(result.brainDbPath)).toBe(true);
    expect(fs.existsSync(result.usersDbPath)).toBe(true);
    expect(fs.existsSync(result.relayPersistDir)).toBe(true);

    // systemd unit rendered with hardening.
    expect(result.serviceKind).toBe('systemd');
    expect(result.serviceFilePath).not.toBeNull();
    const unit = fs.readFileSync(result.serviceFilePath!, 'utf8');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('CapabilityBoundingSet=');
    expect(unit).toContain('SystemCallFilter=@system-service');
    // V8 JIT requires W+X — must be explicitly OFF.
    expect(unit).toContain('MemoryDenyWriteExecute=no');
    expect(unit).toContain(`EnvironmentFile=${result.secretsPath}`);

    // Bootstrap PAT minted with expected shape.
    expect(result.adminPat).toMatch(/^sbp_[a-z0-9]{8}_[A-Z2-7]+$/);
    expect(result.adminTokenId).toMatch(/^[a-z0-9]{8}$/);
    expect(result.adminEmail).toBe('admin@example.com');
    // Default 90-day expiry.
    const expiresMs = new Date(result.adminExpiresAt).getTime();
    const ninetyDays = 90 * 86_400_000;
    expect(expiresMs - Date.now()).toBeGreaterThan(ninetyDays - 60_000);
    expect(expiresMs - Date.now()).toBeLessThan(ninetyDays + 60_000);

    // Output mentions the PAT once.
    expect(stdoutBuf).toContain(result.adminPat);
  });

  it('refuses re-run without --force (idempotency guard)', async () => {
    const opts = {
      platform: 'linux' as const,
      storageDir: tmpPath('storage'),
      secretsPath: tmpPath('etc/second-brain/secrets.env'),
      serviceFilePath: tmpPath('etc/systemd/system/second-brain-server.service'),
      adminEmail: 'admin@example.com',
      stdout: sinkStdout,
    };
    await runInitServer(opts);
    await expect(runInitServer(opts)).rejects.toThrow(/already initialized/);
  });

  it('--force rotates secrets but preserves DBs', async () => {
    const opts = {
      platform: 'linux' as const,
      storageDir: tmpPath('storage'),
      secretsPath: tmpPath('etc/second-brain/secrets.env'),
      serviceFilePath: tmpPath('etc/systemd/system/second-brain-server.service'),
      adminEmail: 'admin@example.com',
      stdout: sinkStdout,
    };
    const first = await runInitServer(opts);
    const firstSecrets = fs.readFileSync(first.secretsPath, 'utf8');
    const firstUsersStat = fs.statSync(first.usersDbPath);

    const second = await runInitServer({ ...opts, force: true });
    const secondSecrets = fs.readFileSync(second.secretsPath, 'utf8');
    expect(secondSecrets).not.toBe(firstSecrets);
    expect(second.rotatedSecrets).toBe(true);
    // DB file still present (the same one — not deleted).
    expect(fs.existsSync(second.usersDbPath)).toBe(true);
    expect(fs.statSync(second.usersDbPath).ino).toBe(firstUsersStat.ino);
  });

  it('rejects --admin-pat-ttl over 365d', async () => {
    await expect(
      runInitServer({
        platform: 'linux',
        storageDir: tmpPath('storage'),
        secretsPath: tmpPath('etc/second-brain/secrets.env'),
        serviceFilePath: tmpPath('etc/systemd/system/second-brain-server.service'),
        adminEmail: 'admin@example.com',
        adminPatTtl: '400d',
        stdout: sinkStdout,
      }),
    ).rejects.toThrow(/365-day/);
  });
});

describe('runInitServer (macOS/launchd)', () => {
  it('writes a launchd plist with KeepAlive dict and no secrets in EnvironmentVariables', async () => {
    const result = await runInitServer({
      platform: 'darwin',
      storageDir: tmpPath('storage'),
      secretsPath: tmpPath('home/.second-brain/secrets.env'),
      serviceFilePath: tmpPath('home/Library/LaunchAgents/dev.secondbrain.server.plist'),
      adminEmail: 'admin@example.com',
      stdout: sinkStdout,
    });
    expect(result.serviceKind).toBe('launchd');
    const plist = fs.readFileSync(result.serviceFilePath!, 'utf8');
    expect(plist).toContain('<key>KeepAlive</key>');
    // KeepAlive must be a dict, not a bare boolean.
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>/);
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<key>ProcessType</key>');
    // Must NOT inline any of the three signing keys.
    expect(plist).not.toContain('BRAIN_SERVER_SIGNING_KEY');
    expect(plist).not.toContain('BRAIN_INVITE_SIGNING_KEY');
    expect(plist).not.toContain('RELAY_AUTH_SECRET');
    // Must source the env file via shell shim.
    expect(plist).toContain(result.secretsPath);
  });
});

describe('renderSystemdUnit / renderLaunchdPlist (snapshots)', () => {
  it('systemd unit contains every Tier-1 hardening directive', () => {
    const unit = renderSystemdUnit({
      user: 'sb',
      storageDir: '/var/lib/sb',
      installDir: '/opt/sb',
      nodeBin: '/usr/bin/node',
      secretsPath: '/etc/sb/secrets.env',
      port: 7430,
      relayPort: 7421,
      publicUrl: 'https://sb.example.com',
    });
    for (const directive of [
      'NoNewPrivileges=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectKernelLogs=yes',
      'ProtectControlGroups=yes',
      'ProtectClock=yes',
      'ProtectProc=invisible',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'RestrictNamespaces=yes',
      'RestrictRealtime=yes',
      'RestrictSUIDSGID=yes',
      'LockPersonality=yes',
      'SystemCallFilter=@system-service',
      'SystemCallArchitectures=native',
      'CapabilityBoundingSet=',
      'AmbientCapabilities=',
      'MemoryDenyWriteExecute=no',
      'OOMPolicy=stop',
    ]) {
      expect(unit).toContain(directive);
    }
  });

  it('launchd plist uses KeepAlive dict and never inlines secrets', () => {
    const plist = renderLaunchdPlist({
      installDir: '/opt/sb',
      nodeBin: '/usr/bin/node',
      secretsPath: '/Users/sb/.second-brain/secrets.env',
      storageDir: '/Users/sb/.second-brain/data',
      port: 7430,
      relayPort: 7421,
      publicUrl: 'http://localhost:7430',
    });
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>/);
    expect(plist).not.toContain('BRAIN_SERVER_SIGNING_KEY');
  });

  it('launchd plist single-quotes path arguments to handle spaces in install/secret paths', () => {
    // A user with spaces in their home dir (common on macOS) must not break
    // the /bin/sh -c body. The shim should produce something like
    //   set -a; . '/Users/Jane Doe/.../secrets.env'; set +a; exec '/usr/bin/node' '/Volumes/My Drive/sb/.../index.mjs'
    const plist = renderLaunchdPlist({
      installDir: '/Volumes/My Drive/second-brain',
      nodeBin: '/Users/Jane Doe/.nvm/v25/bin/node',
      secretsPath: '/Users/Jane Doe/.second-brain/secrets.env',
      storageDir: '/Users/Jane Doe/.second-brain/data',
      port: 7430,
      relayPort: 7421,
      publicUrl: 'http://localhost:7430',
    });
    expect(plist).toContain(`'/Users/Jane Doe/.second-brain/secrets.env'`);
    expect(plist).toContain(`'/Users/Jane Doe/.nvm/v25/bin/node'`);
    expect(plist).toContain(`'/Volumes/My Drive/second-brain/apps/server/dist/index.mjs'`);
    // Make sure unquoted paths with spaces aren't sneaking through anywhere
    // in the shell-command string.
    const shimMatch = plist.match(/<string>set -a;[^<]+<\/string>/);
    expect(shimMatch).not.toBeNull();
    expect(shimMatch![0]).not.toMatch(/\. \/Users\/Jane Doe/);
  });

  it('launchd plist correctly escapes single-quotes in paths', () => {
    // POSIX shell: `foo'bar` → `'foo'\''bar'`
    const plist = renderLaunchdPlist({
      installDir: '/tmp/it’s',
      nodeBin: "/Users/o'malley/node",
      secretsPath: '/tmp/secrets.env',
      storageDir: '/tmp/data',
      port: 7430,
      relayPort: 7421,
      publicUrl: 'http://localhost:7430',
    });
    expect(plist).toContain(`'/Users/o'\\''malley/node'`);
  });
});
