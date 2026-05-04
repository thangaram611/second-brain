/**
 * Per-host credentials pointer file (PR4 §B).
 *
 * Layout: `~/.second-brain/credentials/<host>.json` — file mode 0600, parent
 * dir 0700. Contains non-secret pointers (server URL, namespace, user id,
 * email, token-ids); the actual PAT secrets live in the OS keychain at
 * `pat:<host>:<tokenId>`. Losing the credentials file is recoverable
 * (re-run `brain init client` or read pointers from `whoami`); losing the
 * keychain entry requires `brain auth rotate`.
 *
 * The legacy permissive reader at `lib/resolve-token.ts:readCredentials` is
 * kept around for the hook-binary's hot-path (it tolerates future fields
 * the user hasn't migrated past). New writers always use the strict schema
 * here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const CredentialsRecordSchema = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  namespace: z.string().min(1),
  userId: z.string().min(1),
  email: z.email(),
  defaultTokenId: z.string().min(1),
  hookTokenId: z.string().min(1).optional(),
  cliTokenId: z.string().min(1).optional(),
  redeemedAt: z.iso.datetime(),
  patExpiresAt: z.iso.datetime().optional(),
});

export type CredentialsRecord = z.infer<typeof CredentialsRecordSchema>;

export interface CredentialsHostEntry {
  host: string;
  record: CredentialsRecord;
}

function homeDir(homeOverride?: string): string {
  return homeOverride ?? os.homedir();
}

/** Absolute path to the credentials directory for a given home dir. */
export function credentialsDir(homeOverride?: string): string {
  return path.join(homeDir(homeOverride), '.second-brain', 'credentials');
}

/** Absolute path to a single host's pointer file. */
export function credentialsPath(host: string, homeOverride?: string): string {
  return path.join(credentialsDir(homeOverride), `${host}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  // chmod best-effort — Windows doesn't support POSIX mode bits.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
}

/**
 * Atomic write — writes a sibling tmp file then `rename()`s into place. POSIX
 * rename is atomic, so a concurrent reader sees either the old contents or
 * the new contents, never a partial write. Mirrors the pattern in
 * `lib/rules-refresh.ts:writeFileAtomic`.
 */
function writeFileAtomicSecure(target: string, content: string): void {
  const dir = path.dirname(target);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  // tmp lives in the SAME directory as target, so renameSync cannot fail
  // with EXDEV — they're on the same filesystem by construction. Any rename
  // failure here is a real fault (parent dir gone, hard quota, etc); we let
  // it propagate rather than rewriting target in-place under its old mode,
  // which would briefly leave secrets at whatever mode bits the file
  // previously had.
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore tmp-cleanup */
    }
    throw err;
  }
  // chmod again as defense-in-depth (umask interaction etc); no-op on Windows.
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* ignore */
  }
}

/** Persist a credentials record. Validates with Zod before writing. */
export function writeCredentials(
  host: string,
  record: CredentialsRecord,
  homeOverride?: string,
): { path: string } {
  // Round-trip through the schema so callers passing an `unknown`-shaped
  // object still get caught at write time.
  const validated = CredentialsRecordSchema.parse(record);
  const target = credentialsPath(host, homeOverride);
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  writeFileAtomicSecure(target, json);
  return { path: target };
}

/** Read + parse a credentials record. Returns null on missing/invalid. */
export function readCredentials(
  host: string,
  homeOverride?: string,
): CredentialsRecord | null {
  const target = credentialsPath(host, homeOverride);
  if (!fs.existsSync(target)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = CredentialsRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * List every credentials file in the directory, skipping invalid entries.
 * Filenames must end in `.json`; the host is the basename without extension.
 */
export function listCredentials(
  homeOverride?: string,
): CredentialsHostEntry[] {
  const dir = credentialsDir(homeOverride);
  if (!fs.existsSync(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CredentialsHostEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('.')) continue; // skip atomic-write tmp files
    const host = name.slice(0, -'.json'.length);
    const record = readCredentials(host, homeOverride);
    if (record) out.push({ host, record });
  }
  return out;
}

/** Remove a host's credentials file. No-op when absent. */
export function deleteCredentials(host: string, homeOverride?: string): void {
  const target = credentialsPath(host, homeOverride);
  try {
    fs.unlinkSync(target);
  } catch {
    /* ignore — already gone */
  }
}
