/**
 * Discoverable local-server config — written by `brain init server`, read by
 * `brain doctor`. Always at `$HOME/.second-brain/server.json` regardless of
 * the user's `--storage-dir`, so doctor can find it without flags.
 *
 * Presence of this file marks the box as a SERVER install; absence means
 * the box is a client only and doctor skips the local-server/local-relay
 * checks entirely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

const PortSchema = z.number().int().min(1).max(65535);

export const ServerConfigSchema = z.object({
  apiPort: PortSchema,
  relayPort: PortSchema,
  publicUrl: z.string().url(),
  storageDir: z.string().min(1),
  secretsPath: z.string().min(1),
  /** Absolute path to the systemd unit / launchd plist; null on manual platforms. */
  serviceFilePath: z.string().nullable(),
  relayServiceFilePath: z.string().nullable(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function serverConfigPath(home: string): string {
  return path.join(home, '.second-brain', 'server.json');
}

export function writeServerConfig(home: string, cfg: ServerConfig): void {
  const target = serverConfigPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o644 });
}

/**
 * Read + parse `server.json`. Returns `null` if the file does not exist
 * (caller treats the box as a client). Throws on malformed JSON or schema
 * failure — `safeReadServerConfig` below wraps this for non-throwing callers.
 */
export function readServerConfig(home: string): ServerConfig | null {
  const target = serverConfigPath(home);
  if (!fs.existsSync(target)) return null;
  return ServerConfigSchema.parse(JSON.parse(fs.readFileSync(target, 'utf8')));
}

export type SafeReadResult =
  | { ok: true; value: ServerConfig | null }
  | { ok: false; error: string };

export function safeReadServerConfig(home: string): SafeReadResult {
  try {
    return { ok: true, value: readServerConfig(home) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
