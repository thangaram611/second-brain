import { Brain, createLogger } from '@second-brain/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
export const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

export const cliLogger = createLogger('cli');

export function getServerUrl(override?: string): string {
  return (
    override ??
    process.env.BRAIN_API_URL ??
    process.env.BRAIN_SERVER_URL ??
    process.env.SECOND_BRAIN_SERVER_URL ??
    'http://localhost:7430'
  );
}

export function buildAuthHeaders(token?: string): Record<string, string> {
  const resolved = token ?? process.env.BRAIN_AUTH_TOKEN;
  return resolved ? { Authorization: `Bearer ${resolved}` } : {};
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
