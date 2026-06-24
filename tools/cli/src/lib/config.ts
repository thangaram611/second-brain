import { Brain, createLogger } from '@second-brain/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Re-export the URL helpers from their dependency-leaf module so existing
// importers (`from './config.js'`) keep working while `resolve-token.ts` can
// import the same functions without forming a runtime cycle with this module
// (config dynamically imports resolve-token in `buildAuthHeadersAsync`).
export { getServerUrl, hostFromUrl } from './server-url.js';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

export const cliLogger = createLogger('cli');

export function buildAuthHeaders(token?: string): Record<string, string> {
  const resolved = token ?? process.env.BRAIN_AUTH_TOKEN;
  return resolved ? { Authorization: `Bearer ${resolved}` } : {};
}

/**
 * Async variant that consults `resolve-token.ts` (env → credentials file +
 * keychain). Falls back to plain `buildAuthHeaders()` if no token is found.
 *
 * Use this from long-running paths (CLI commands, hook binary). The sync
 * `buildAuthHeaders` remains for callers that already have a token in hand.
 */
export async function buildAuthHeadersAsync(
  token?: string,
): Promise<Record<string, string>> {
  if (token) return { Authorization: `Bearer ${token}` };
  const { resolveToken } = await import('./resolve-token.js');
  const resolved = await resolveToken();
  if (resolved) return { Authorization: `Bearer ${resolved.token}` };
  return {};
}

export function getDbPath(): string {
  return process.env.BRAIN_DB_PATH ?? DEFAULT_DB_PATH;
}

export function openBrain(): Brain {
  const dbPath = getDbPath();
  if (!fs.existsSync(path.dirname(dbPath))) {
    console.error(`Brain not initialized. Run: brain init`);
    process.exit(1);
  }
  return new Brain({ path: dbPath });
}
