/**
 * File-backed secret store — fallback / default for hosts where the OS
 * keychain isn't usable (notably macOS without an unlocked login keychain,
 * which would pop a destructive "Reset to Defaults" dialog from the
 * Security framework before our error-handler can intervene).
 *
 * Layout:
 *   ~/.second-brain/credentials/secrets/<sha256-base64url(account)>.json
 *
 * Each file is mode 0600; the enclosing dir is mode 0700. Atomic writes
 * via `<file>.tmp.<rand>` + rename so a crash never leaves a half-written
 * secret on disk. Content shape is Zod-validated on read — corrupted or
 * tampered files return null rather than throwing.
 *
 * On a single-user FileVault Mac this is at-rest-equivalent to the legacy
 * file-based keychain (both decrypt at login). PATs stored here are
 * server-revocable and namespace-scoped, so the ACL win of OS-keychain is
 * marginal for this codebase's threat model.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { z } from 'zod';

const SECRETS_SUBDIR = path.join('credentials', 'secrets');

const SecretFileSchema = z.object({
  v: z.literal(1),
  account: z.string().min(1),
  secret: z.string().min(1),
  createdAt: z.string().min(1),
});

type SecretFile = z.infer<typeof SecretFileSchema>;

function accountKey(account: string): string {
  return crypto.createHash('sha256').update(account).digest('base64url');
}

function secretsDirFor(homeDir: string | undefined): string {
  return path.join(homeDir ?? os.homedir(), '.second-brain', SECRETS_SUBDIR);
}

function secretPathFor(account: string, homeDir: string | undefined): string {
  return path.join(secretsDirFor(homeDir), `${accountKey(account)}.json`);
}

export async function fileStoreSet(
  account: string,
  secret: string,
  homeDir?: string,
): Promise<void> {
  const dir = secretsDirFor(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: SecretFile = {
    v: 1,
    account,
    secret,
    createdAt: new Date().toISOString(),
  };
  const final = secretPathFor(account, homeDir);
  const tmp = `${final}.tmp.${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmp, final);
}

export async function fileStoreGet(
  account: string,
  homeDir?: string,
): Promise<string | null> {
  const file = secretPathFor(account, homeDir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const data: unknown = JSON.parse(raw);
    const parsed = SecretFileSchema.safeParse(data);
    if (!parsed.success) return null;
    // Defence in depth — refuse to serve a value if the file got mismatched
    // for the requested account (rename/copy attacks).
    if (parsed.data.account !== account) return null;
    return parsed.data.secret;
  } catch {
    return null;
  }
}

export async function fileStoreDelete(
  account: string,
  homeDir?: string,
): Promise<boolean> {
  const file = secretPathFor(account, homeDir);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function fileStorePath(account: string, homeDir?: string): string {
  return secretPathFor(account, homeDir);
}
