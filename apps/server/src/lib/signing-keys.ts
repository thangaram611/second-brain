/**
 * Signing-key loader.
 *
 * Loads `BRAIN_SERVER_SIGNING_KEY` and `BRAIN_INVITE_SIGNING_KEY` from
 *   1. process.env (highest priority), or
 *   2. /etc/second-brain/secrets.env (if readable, KEY=VALUE per line)
 *
 * In team mode (`BRAIN_AUTH_MODE === 'pat'`) both keys MUST be present —
 * `requireSigningKeys()` throws fast at boot. In solo mode the absence
 * of either key is tolerated; the relevant routes simply refuse to mint
 * or accept signed material.
 */
import { readFileSync, existsSync } from 'node:fs';

export interface SigningKeys {
  /** HMAC key used for PATs (and any other server-issued bearer tokens). */
  serverSigningKey: string | null;
  /** HMAC key used for invite tokens. */
  inviteSigningKey: string | null;
}

const SECRETS_FILE_PATH = '/etc/second-brain/secrets.env';

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readSecretsFile(path: string = SECRETS_FILE_PATH): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const content = readFileSync(path, 'utf8');
    return parseDotenv(content);
  } catch {
    return {};
  }
}

export function loadSigningKeys(opts?: {
  env?: NodeJS.ProcessEnv;
  secretsFilePath?: string;
}): SigningKeys {
  const env = opts?.env ?? process.env;
  const fileSecrets = readSecretsFile(opts?.secretsFilePath);

  const serverSigningKey = nonEmpty(env.BRAIN_SERVER_SIGNING_KEY) ?? nonEmpty(fileSecrets.BRAIN_SERVER_SIGNING_KEY) ?? null;
  const inviteSigningKey = nonEmpty(env.BRAIN_INVITE_SIGNING_KEY) ?? nonEmpty(fileSecrets.BRAIN_INVITE_SIGNING_KEY) ?? null;

  return { serverSigningKey, inviteSigningKey };
}

function nonEmpty(v: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  return v.length > 0 ? v : null;
}

/** Throws if either key is missing — call this when entering team mode. */
export function requireSigningKeys(keys: SigningKeys): { serverSigningKey: string; inviteSigningKey: string } {
  if (!keys.serverSigningKey) {
    throw new Error(
      'BRAIN_SERVER_SIGNING_KEY is required when BRAIN_AUTH_MODE=pat. ' +
        'Set it via env or /etc/second-brain/secrets.env.',
    );
  }
  if (!keys.inviteSigningKey) {
    throw new Error(
      'BRAIN_INVITE_SIGNING_KEY is required when BRAIN_AUTH_MODE=pat. ' +
        'Set it via env or /etc/second-brain/secrets.env.',
    );
  }
  return {
    serverSigningKey: keys.serverSigningKey,
    inviteSigningKey: keys.inviteSigningKey,
  };
}
