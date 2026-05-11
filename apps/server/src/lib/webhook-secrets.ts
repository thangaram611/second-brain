import type { WebhookSecret } from '@second-brain/collectors';

const LEGACY_TOKEN_PREFIX = 'SECOND_BRAIN_WEBHOOK_SECRET__';
const LEGACY_HMAC_PREFIX = 'SECOND_BRAIN_WEBHOOK_HMAC__';
const TOKEN_HEX_PREFIX = 'SECOND_BRAIN_WEBHOOK_SECRET_HEX__';
const HMAC_HEX_PREFIX = 'SECOND_BRAIN_WEBHOOK_HMAC_HEX__';

function decodeProjectIdHex(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

function maybeAddLegacySecret(
  out: Map<string, WebhookSecret>,
  envKey: string,
  envValue: string,
  prefix: string,
  kind: 'token' | 'hmac',
): boolean {
  if (!envKey.startsWith(prefix)) return false;
  const rest = envKey.slice(prefix.length);
  const split = rest.indexOf('__');
  if (split <= 0) return true;
  const provider = rest.slice(0, split);
  const projectId = rest.slice(split + 2);
  if (!provider || !projectId) return true;
  out.set(
    `${provider}:${projectId}`,
    kind === 'token' ? { kind: 'token', value: envValue } : { kind: 'hmac', key: envValue },
  );
  return true;
}

function maybeAddHexSecret(
  out: Map<string, WebhookSecret>,
  envKey: string,
  envValue: string,
  prefix: string,
  kind: 'token' | 'hmac',
): boolean {
  if (!envKey.startsWith(prefix)) return false;
  const rest = envKey.slice(prefix.length);
  const split = rest.indexOf('__');
  if (split <= 0) return true;
  const provider = rest.slice(0, split);
  const projectId = decodeProjectIdHex(rest.slice(split + 2));
  if (!provider || !projectId) return true;
  out.set(
    `${provider}:${projectId}`,
    kind === 'token' ? { kind: 'token', value: envValue } : { kind: 'hmac', key: envValue },
  );
  return true;
}

export function loadWebhookSecretsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, WebhookSecret> {
  const out = new Map<string, WebhookSecret>();
  for (const [envKey, envValue] of Object.entries(env)) {
    if (typeof envValue !== 'string' || envValue.length === 0) continue;
    if (maybeAddHexSecret(out, envKey, envValue, TOKEN_HEX_PREFIX, 'token')) continue;
    if (maybeAddHexSecret(out, envKey, envValue, HMAC_HEX_PREFIX, 'hmac')) continue;
    if (maybeAddLegacySecret(out, envKey, envValue, LEGACY_TOKEN_PREFIX, 'token')) continue;
    maybeAddLegacySecret(out, envKey, envValue, LEGACY_HMAC_PREFIX, 'hmac');
  }
  return out;
}

