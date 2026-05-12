/**
 * `brain doctor` (PR4 §F).
 *
 * Walks the local install and prints ✓ / ⚠ / ✗ for each check. Exits 0 if
 * all checks pass or only warnings, 1 on any failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { listCredentials, type CredentialsRecord } from './credentials.js';
import { readSecret, loadKeytar } from './keychain.js';
import { loadTeamManifest, hashTeamManifest } from './team-manifest.js';
import { loadWiredRepos, computeRepoHash } from './git-context-daemon.js';
import {
  safeReadServerConfig,
  serverConfigPath,
  type ServerConfig,
} from './lib/server-config.js';

const LocalHealthSchema = z.object({ status: z.literal('ok') }).passthrough();

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorOptions {
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override HOME (tests). */
  homeDir?: string;
  /** Override cwd (tests). */
  cwd?: string;
  /** Stream destination (tests). */
  stdout?: { write(s: string): void };
}

export interface DoctorResult {
  exitCode: 0 | 1;
  checks: CheckResult[];
}

const WhoamiSchema = z.object({
  mode: z.enum(['open', 'pat']).optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
  role: z.enum(['member', 'admin']).optional(),
  namespace: z.string().nullable().optional(),
});

interface HostContext {
  host: string;
  record: CredentialsRecord;
}

function patAccount(host: string, tokenId: string): string {
  return `pat:${host}:${tokenId}`;
}

async function checkLocalServerReachable(
  cfg: ServerConfig,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const url = `http://localhost:${cfg.apiPort}/health`;
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      return {
        name: 'local server reachable',
        status: 'fail',
        message: `${url} → ${res.status} ${res.statusText} — service may have failed to start (check journalctl / launchctl).`,
      };
    }
    const json: unknown = await res.json();
    const parsed = LocalHealthSchema.safeParse(json);
    if (!parsed.success) {
      return {
        name: 'local server reachable',
        status: 'warn',
        message: `${url} → 200 but unexpected shape: ${z.prettifyError(parsed.error)}`,
      };
    }
    return {
      name: 'local server reachable',
      status: 'pass',
      message: `${url} → 200 (status=ok).`,
    };
  } catch (e) {
    return {
      name: 'local server reachable',
      status: 'fail',
      message: `${url} unreachable: ${e instanceof Error ? e.message : String(e)} — load server plist/unit (\`launchctl load …server.plist\` or \`sudo systemctl enable --now second-brain-server\`).`,
    };
  }
}

async function checkLocalRelayReachable(
  cfg: ServerConfig,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const url = `http://localhost:${cfg.relayPort}/health`;
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      return {
        name: 'local relay reachable',
        status: 'fail',
        message: `${url} → ${res.status} ${res.statusText} — load relay plist/unit (\`launchctl load …relay.plist\` or \`sudo systemctl enable --now second-brain-relay\`).`,
      };
    }
    const json: unknown = await res.json();
    const parsed = LocalHealthSchema.safeParse(json);
    if (!parsed.success) {
      return {
        name: 'local relay reachable',
        status: 'warn',
        message: `${url} → 200 but unexpected shape: ${z.prettifyError(parsed.error)}`,
      };
    }
    return {
      name: 'local relay reachable',
      status: 'pass',
      message: `${url} → 200 (status=ok).`,
    };
  } catch (e) {
    return {
      name: 'local relay reachable',
      status: 'fail',
      message: `${url} unreachable: ${e instanceof Error ? e.message : String(e)} — load relay plist/unit (\`launchctl load …relay.plist\` or \`sudo systemctl enable --now second-brain-relay\`).`,
    };
  }
}

async function checkServerReachable(
  ctx: HostContext,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  try {
    const res = await fetchImpl(`${ctx.record.serverUrl}/health`, { method: 'GET' });
    if (res.ok) {
      return {
        name: `server reachable (${ctx.host})`,
        status: 'pass',
        message: `${ctx.record.serverUrl}/health → 200`,
      };
    }
    return {
      name: `server reachable (${ctx.host})`,
      status: 'fail',
      message: `${ctx.record.serverUrl}/health → ${res.status} ${res.statusText}`,
    };
  } catch (e) {
    return {
      name: `server reachable (${ctx.host})`,
      status: 'fail',
      message: `request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function checkPatValid(
  ctx: HostContext,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const account = patAccount(ctx.host, ctx.record.defaultTokenId);
  const secret = await readSecret(account);
  if (!secret.ok) {
    return {
      name: `PAT valid (${ctx.host})`,
      status: 'fail',
      message: `keychain unavailable: ${secret.message}`,
    };
  }
  if (secret.value === null) {
    return {
      name: `PAT valid (${ctx.host})`,
      status: 'fail',
      message: `no keychain entry at ${account} — re-run \`brain init client\`.`,
    };
  }
  try {
    const res = await fetchImpl(`${ctx.record.serverUrl}/api/auth/whoami`, {
      headers: { Authorization: `Bearer ${secret.value}` },
    });
    if (!res.ok) {
      return {
        name: `PAT valid (${ctx.host})`,
        status: 'fail',
        message: `whoami → ${res.status}; PAT may be revoked. Try \`brain auth rotate\`.`,
      };
    }
    const json: unknown = await res.json();
    const parsed = WhoamiSchema.safeParse(json);
    if (!parsed.success) {
      return {
        name: `PAT valid (${ctx.host})`,
        status: 'warn',
        message: `whoami response shape unexpected: ${z.prettifyError(parsed.error)}`,
      };
    }
    if (parsed.data.userId !== undefined && parsed.data.userId !== ctx.record.userId) {
      return {
        name: `PAT valid (${ctx.host})`,
        status: 'fail',
        message: `whoami userId=${parsed.data.userId} but credentials say ${ctx.record.userId}`,
      };
    }
    return {
      name: `PAT valid (${ctx.host})`,
      status: 'pass',
      message: `whoami → 200 (mode=${parsed.data.mode ?? 'pat'})`,
    };
  } catch (e) {
    return {
      name: `PAT valid (${ctx.host})`,
      status: 'fail',
      message: `whoami request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function checkPatExpiry(ctx: HostContext): CheckResult {
  if (!ctx.record.patExpiresAt) {
    return {
      name: `PAT expiry (${ctx.host})`,
      status: 'warn',
      message: 'no expiry set — recommend setting one (OWASP ASVS 5.0 §3.3).',
    };
  }
  const expiresMs = Date.parse(ctx.record.patExpiresAt);
  const remainingDays = (expiresMs - Date.now()) / 86_400_000;
  if (remainingDays <= 0) {
    return {
      name: `PAT expiry (${ctx.host})`,
      status: 'fail',
      message: `expired ${ctx.record.patExpiresAt}; run \`brain auth rotate\`.`,
    };
  }
  if (remainingDays < 7) {
    return {
      name: `PAT expiry (${ctx.host})`,
      status: 'warn',
      message: `expires in ${remainingDays.toFixed(1)}d (${ctx.record.patExpiresAt}); rotate soon.`,
    };
  }
  return {
    name: `PAT expiry (${ctx.host})`,
    status: 'pass',
    message: `expires in ${remainingDays.toFixed(0)}d (${ctx.record.patExpiresAt}).`,
  };
}

function checkKeychainEntry(ctx: HostContext): Promise<CheckResult> {
  return readSecret(patAccount(ctx.host, ctx.record.defaultTokenId)).then((res) => {
    if (!res.ok) {
      return {
        name: `keychain entry (${ctx.host})`,
        status: 'warn' as const,
        message: `keychain unavailable: ${res.message}`,
      };
    }
    if (res.value === null) {
      return {
        name: `keychain entry (${ctx.host})`,
        status: 'fail' as const,
        message: `missing entry at pat:${ctx.host}:${ctx.record.defaultTokenId}`,
      };
    }
    return {
      name: `keychain entry (${ctx.host})`,
      status: 'pass' as const,
      message: `present at pat:${ctx.host}:${ctx.record.defaultTokenId}`,
    };
  });
}

function checkAuthTokenEnv(): CheckResult {
  const env = process.env.BRAIN_AUTH_TOKEN;
  if (!env) {
    return {
      name: 'BRAIN_AUTH_TOKEN env',
      status: 'pass',
      message: 'unset (preferred — keychain-resolved PATs are used).',
    };
  }
  if (env.startsWith('sbp_')) {
    return {
      name: 'BRAIN_AUTH_TOKEN env',
      status: 'warn',
      message: 'set to a PAT — clears keychain resolution priority. Unset unless intentional (CI).',
    };
  }
  return {
    name: 'BRAIN_AUTH_TOKEN env',
    status: 'warn',
    message: 'set to a non-PAT; most auth paths expect sbp_ PATs. Unset it or replace it with a minted PAT.',
  };
}

interface RepoCheckCtx {
  repoRoot: string;
  homeDir: string;
}

function checkManifestDrift(ctx: RepoCheckCtx): CheckResult {
  const loaded = loadTeamManifest(ctx.repoRoot);
  if (!loaded.ok) {
    if (loaded.reason === 'not-found') {
      return {
        name: `team manifest (${ctx.repoRoot})`,
        status: 'pass',
        message: 'no team.json — solo repo.',
      };
    }
    // unreadable / invalid-json / invalid-schema all genuinely fail.
    return {
      name: `team manifest (${ctx.repoRoot})`,
      status: 'fail',
      message: `${loaded.reason}: ${loaded.detail ?? ''}`,
    };
  }
  const currentHash = hashTeamManifest(loaded.manifest);
  const wired = loadWiredRepos();
  const repoHash = computeRepoHash(ctx.repoRoot);
  const entry = wired.wiredRepos[repoHash];
  if (!entry) {
    return {
      name: `team manifest (${ctx.repoRoot})`,
      status: 'warn',
      message: 'manifest present but repo not wired — run `brain init client --invite ...` or `brain wire-assistant all`.',
    };
  }
  // The wired-repos snapshot doesn't currently store the manifest hash;
  // PR4 stores it in a sibling file so doctor can detect drift across runs.
  const snapshotPath = path.join(ctx.homeDir, '.second-brain', '.manifest-snapshots.json');
  const snapshot = readManifestSnapshots(snapshotPath);
  const previousHash = snapshot.hashes[repoHash];
  if (!previousHash) {
    snapshot.hashes[repoHash] = currentHash;
    writeManifestSnapshots(snapshotPath, snapshot);
    return {
      name: `team manifest (${ctx.repoRoot})`,
      status: 'pass',
      message: `hash recorded for first time: ${currentHash.slice(0, 12)}…`,
    };
  }
  if (previousHash === currentHash) {
    return {
      name: `team manifest (${ctx.repoRoot})`,
      status: 'pass',
      message: `hash unchanged (${currentHash.slice(0, 12)}…).`,
    };
  }
  return {
    name: `team manifest (${ctx.repoRoot})`,
    status: 'warn',
    message: `manifest changed since last wire (${previousHash.slice(0, 12)}… → ${currentHash.slice(0, 12)}…). Re-run \`brain wire-assistant all\` if hooks may need updating.`,
  };
}

function checkAdapterSidecars(ctx: RepoCheckCtx): CheckResult[] {
  const claudeUserSettings = path.join(ctx.homeDir, '.claude', 'settings.json');
  const cursorProjectHooks = path.join(ctx.repoRoot, '.cursor', 'hooks.json');
  const codexHooks = path.join(ctx.homeDir, '.codex', 'hooks.json');
  const copilotHooks = path.join(ctx.repoRoot, '.github', 'hooks', 'second-brain.json');

  const candidates: Array<{ name: string; path: string }> = [
    { name: 'claude (~/.claude/settings.json)', path: claudeUserSettings },
    { name: 'cursor (.cursor/hooks.json)', path: cursorProjectHooks },
    { name: 'codex (~/.codex/hooks.json)', path: codexHooks },
    { name: 'copilot (.github/hooks/second-brain.json)', path: copilotHooks },
  ];

  return candidates.map((c) => {
    if (!fs.existsSync(c.path)) {
      return {
        name: `adapter sidecar — ${c.name}`,
        status: 'pass' as const, // not installed is OK; only fail when installed-but-stale
        message: 'not installed.',
      };
    }
    let content: string;
    try {
      content = fs.readFileSync(c.path, 'utf8');
    } catch (e) {
      return {
        name: `adapter sidecar — ${c.name}`,
        status: 'fail' as const,
        message: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!content.includes('# brain:v2')) {
      return {
        name: `adapter sidecar — ${c.name}`,
        status: 'fail' as const,
        message: 'present but missing the `# brain:v2` sentinel — re-run `brain wire-assistant`.',
      };
    }
    return {
      name: `adapter sidecar — ${c.name}`,
      status: 'pass' as const,
      message: 'present + sentinel ok.',
    };
  });
}

function checkGitHooks(ctx: RepoCheckCtx): CheckResult {
  const hooksDir = path.join(ctx.repoRoot, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    return {
      name: `git hooks (${ctx.repoRoot})`,
      status: 'pass',
      message: 'no .git/hooks directory — solo or non-git repo.',
    };
  }
  const sidecarPath = path.join(ctx.repoRoot, '.second-brain', 'git-hooks-sidecar.json');
  if (!fs.existsSync(sidecarPath)) {
    return {
      name: `git hooks (${ctx.repoRoot})`,
      status: 'pass',
      message: 'no second-brain git hooks installed.',
    };
  }
  const names = ['post-commit', 'post-merge', 'post-checkout'];
  const issues: string[] = [];
  for (const n of names) {
    const p = path.join(hooksDir, n);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    if (!body.includes('Installed by second-brain')) continue;
    if (!body.includes('NAMESPACE=')) {
      issues.push(`${n}: missing NAMESPACE assignment`);
    }
  }
  if (issues.length > 0) {
    return {
      name: `git hooks (${ctx.repoRoot})`,
      status: 'fail',
      message: issues.join('; '),
    };
  }
  return {
    name: `git hooks (${ctx.repoRoot})`,
    status: 'pass',
    message: 'second-brain git hooks installed and reference NAMESPACE.',
  };
}

// ABI probe — load native modules and surface a fix hint on mismatch.
// nvm/fnm switches after install leave better-sqlite3's prebuilt binary
// compiled against the wrong NODE_MODULE_VERSION; keytar lacking a build/
// directory shows up as a runtime import failure. Both are recoverable
// via `pnpm rebuild-native` (or `pnpm install --force`).
async function checkBetterSqlite3Abi(): Promise<CheckResult> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return {
      name: 'native module ABI (better-sqlite3)',
      status: 'pass',
      message: 'loaded + in-memory DB opened OK.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('NODE_MODULE_VERSION')) {
      return {
        name: 'native module ABI (better-sqlite3)',
        status: 'fail',
        message:
          'NODE_MODULE_VERSION mismatch — run `pnpm rebuild-native` or `pnpm install --force`.',
      };
    }
    return {
      name: 'native module load (better-sqlite3)',
      status: 'fail',
      message,
    };
  }
}

async function checkKeytarAbi(): Promise<CheckResult> {
  const state = await loadKeytar();
  if ('keytar' in state) {
    return {
      name: 'native module ABI (keytar)',
      status: 'pass',
      message: 'loaded OK.',
    };
  }
  // module-missing only — runtime-error is T4 territory and reported elsewhere.
  if (state.message.includes('NODE_MODULE_VERSION')) {
    return {
      name: 'native module ABI (keytar)',
      status: 'fail',
      message:
        'NODE_MODULE_VERSION mismatch — run `pnpm rebuild-native` or `pnpm install --force`.',
    };
  }
  return {
    name: 'native module ABI (keytar)',
    status: 'warn',
    message: `keytar not loadable (${state.message}); keychain features unavailable.`,
  };
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const homeDir = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;

  const checks: CheckResult[] = [];

  // Native-module ABI probes run first — a NODE_MODULE_VERSION mismatch
  // makes the per-host checks below useless, so surface the fix hint up top.
  checks.push(await checkBetterSqlite3Abi());
  checks.push(await checkKeytarAbi());

  // Top-level local checks — only fire on a SERVER box (server.json present
  // at $HOME/.second-brain/server.json). Client-only boxes skip these.
  const localCfg = safeReadServerConfig(homeDir);
  if (localCfg.ok && localCfg.value !== null) {
    checks.push(await checkLocalServerReachable(localCfg.value, fetchImpl));
    checks.push(await checkLocalRelayReachable(localCfg.value, fetchImpl));
  } else if (!localCfg.ok) {
    checks.push({
      name: 'local server config',
      status: 'fail',
      message: `${serverConfigPath(homeDir)} unreadable: ${localCfg.error}. Re-run \`brain init server --force\` to rewrite.`,
    });
  }

  // Per-host checks (one set per credentials record).
  const hosts = listCredentials(homeDir);
  if (hosts.length === 0) {
    checks.push({
      name: 'credentials',
      status: 'warn',
      message: 'no credentials files found — run `brain init client --invite ...`.',
    });
  }
  for (const { host, record } of hosts) {
    const ctx: HostContext = { host, record };
    checks.push(await checkServerReachable(ctx, fetchImpl));
    checks.push(await checkPatValid(ctx, fetchImpl));
    checks.push(checkPatExpiry(ctx));
    checks.push(await checkKeychainEntry(ctx));
  }
  checks.push(checkAuthTokenEnv());

  // Per-repo checks (when cwd is inside a repo).
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const ctx: RepoCheckCtx = { repoRoot, homeDir };
    checks.push(checkManifestDrift(ctx));
    for (const r of checkAdapterSidecars(ctx)) {
      checks.push(r);
    }
    checks.push(checkGitHooks(ctx));
  }

  // Print + summarize.
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.status === 'pass') pass++;
    else if (c.status === 'warn') warn++;
    else fail++;
  }
  const lines = ['brain doctor', ''];
  for (const c of checks) {
    const glyph = c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
    lines.push(`  ${glyph}  ${c.name}: ${c.message}`);
  }
  lines.push('', `  ${pass} pass, ${warn} warn, ${fail} fail`, '');
  stdout.write(lines.join('\n'));

  return { exitCode: fail > 0 ? 1 : 0, checks };
}

function findRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.second-brain'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ── Manifest-snapshot persistence ──────────────────────────────────────────
// Versioned envelope so a future schema change can be recognized at parse
// time. Atomic write (tmp + rename, same dir) closes the window where two
// concurrent `brain doctor` runs could lose updates to each other's writes.
const ManifestSnapshotSchema = z.object({
  version: z.literal(1),
  hashes: z.record(z.string(), z.string()),
});

type ManifestSnapshot = z.infer<typeof ManifestSnapshotSchema>;

function readManifestSnapshots(snapshotPath: string): ManifestSnapshot {
  if (!fs.existsSync(snapshotPath)) return { version: 1, hashes: {} };
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch {
    return { version: 1, hashes: {} };
  }
  if (!raw.trim()) return { version: 1, hashes: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, hashes: {} };
  }
  const result = ManifestSnapshotSchema.safeParse(parsed);
  if (result.success) return result.data;
  return { version: 1, hashes: {} };
}

function writeManifestSnapshots(snapshotPath: string, snapshot: ManifestSnapshot): void {
  const dir = path.dirname(snapshotPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(snapshotPath)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, snapshotPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
