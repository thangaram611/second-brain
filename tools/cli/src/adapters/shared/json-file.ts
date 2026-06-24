/**
 * Shared JSON-file IO + structural guards for the assistant adapters.
 *
 * Every adapter writes a host config file as pretty-printed JSON with a
 * trailing newline, and best-effort loads a possibly-missing/possibly-garbage
 * file into a plain record. This module is the single home for that logic so
 * the four adapters (and rules-refresh) no longer carry byte-identical copies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Narrow an unknown value to a non-null, non-array plain object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Write `value` as pretty JSON (2-space indent + trailing newline), mkdir -p. */
export function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/**
 * Best-effort JSON load. Returns the parsed value when it's a non-null
 * object; otherwise returns null. The caller is responsible for validating
 * the structural shape (we keep this thin and pure).
 */
export function loadJsonObject(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) obj[k] = v;
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/** Escape a string for safe interpolation into a `RegExp`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
