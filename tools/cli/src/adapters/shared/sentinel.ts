/**
 * Shared sentinel-based dedup for adapter hook lists + markdown rule blocks.
 *
 * Every adapter writes hook commands carrying the `HOOK_SENTINEL` suffix and
 * dedups on it: an entry whose command exactly matches is left alone; an entry
 * carrying the sentinel but a stale command is rewritten in place; otherwise a
 * fresh entry is appended. Uninstall filters out every sentinel-carrying entry.
 *
 * The markdown helpers manage a sentinel-delimited block inside a rules file
 * (Copilot instructions / Cursor `.mdc`) without touching surrounding content.
 */

import { HOOK_SENTINEL } from '../types.js';
import { escapeRegExp } from './json-file.js';

/**
 * Upsert `desiredCommand` into a flat list of command-bearing entries using
 * sentinel dedup. Returns the (mutated) list and whether anything changed:
 *   - exact match present → no change;
 *   - stale sentinel entry → command rewritten in place (changed);
 *   - no match → a fresh entry built via `make` is appended (changed).
 */
export function upsertSentinelDedup<T extends { command: string }>(
  list: T[],
  desiredCommand: string,
  make: (cmd: string) => T,
): { list: T[]; changed: boolean } {
  let matched = false;
  let updated = false;
  for (const item of list) {
    if (item.command === desiredCommand) {
      matched = true;
    } else if (item.command.includes(HOOK_SENTINEL)) {
      item.command = desiredCommand;
      matched = true;
      updated = true;
    }
  }
  if (!matched) list.push(make(desiredCommand));
  return { list, changed: !matched || updated };
}

/**
 * Filter out every sentinel-carrying entry from a flat command list. Returns
 * the kept entries and whether anything was removed.
 */
export function removeSentinelEntries<T extends { command: string }>(
  list: T[],
): { list: T[]; removed: boolean } {
  const kept = list.filter((c) => !c.command.includes(HOOK_SENTINEL));
  return { list: kept, removed: kept.length !== list.length };
}

const DEFAULT_BEGIN = '<!-- begin:second-brain -->';
const DEFAULT_END = '<!-- end:second-brain -->';

/**
 * Replace (or insert) a sentinel-delimited block inside `existing`. Content
 * outside the markers is preserved verbatim.
 */
export function upsertSentinelBlock(
  existing: string,
  blockBody: string,
  markers: { begin: string; end: string } = { begin: DEFAULT_BEGIN, end: DEFAULT_END },
): string {
  const { begin, end } = markers;
  const re = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, 'm');
  const replacement = `${begin}\n${blockBody.trim()}\n${end}`;
  if (re.test(existing)) return existing.replace(re, replacement);
  if (existing.length === 0) return `${replacement}\n`;
  return `${existing.replace(/\s+$/, '')}\n\n${replacement}\n`;
}
