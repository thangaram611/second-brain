/**
 * Single source of truth for the brain-hook command vocabulary.
 *
 * Both sides of the hook bridge consume this module:
 *   - the WRITER adapters (claude/codex/copilot/cursor) render hook commands
 *     via `brainHookCommand`, mapping each host event onto a brain verb+phase;
 *   - the RUNTIME `brain-hook` binary parses those same verbs/phases/flags and
 *     routes each verb to its `/api/observe/*` endpoint via `ENDPOINT`.
 *
 * Because the verb list, phases, endpoint map and command renderer all live
 * here, adding or renaming a hook verb/phase is (close to) a one-file edit.
 */

import { HOOK_SENTINEL, type AdapterName } from '../types.js';

export type { AdapterName } from '../types.js';

/** The brain hook verbs (first positional arg of every emitted command). */
export const HOOK_VERBS = [
  'session-start',
  'prompt-submit',
  'tool-use',
  'stop',
  'session-end',
] as const;
export type HookVerb = (typeof HOOK_VERBS)[number];

/** Tool-use phases (the optional `--phase` flag). */
export type Phase = 'pre' | 'post' | 'post-inject';

/** Verb → server endpoint the runtime POSTs to. */
export const ENDPOINT: Record<HookVerb, string> = {
  'session-start': '/api/observe/session-start',
  'prompt-submit': '/api/observe/prompt-submit',
  'tool-use': '/api/observe/tool-use',
  stop: '/api/observe/stop',
  'session-end': '/api/observe/session-end',
};

export function isHookVerb(s: string | undefined): s is HookVerb {
  if (s === undefined) return false;
  for (const v of HOOK_VERBS) if (v === s) return true;
  return false;
}

export function parsePhase(s: string | undefined): Phase | undefined {
  if (s === 'pre' || s === 'post' || s === 'post-inject') return s;
  return undefined;
}

export function parseAdapter(s: string | undefined): AdapterName {
  if (s === 'cursor' || s === 'codex' || s === 'copilot' || s === 'claude') return s;
  return 'claude';
}

/**
 * Render the hook command string emitted into a host config file:
 *   `${bin} <verb> [--phase X] --adapter Y ${HOOK_SENTINEL}`.
 *
 * The trailing sentinel is a POSIX-comment suffix (ignored by the shell) that
 * the writer dedup logic uses as a stable "ours" marker across binary-path
 * changes and version bumps.
 */
export function brainHookCommand(opts: {
  verb: HookVerb;
  phase?: Phase;
  adapter: AdapterName;
  bin?: string;
}): string {
  const bin = opts.bin ?? 'brain-hook';
  const phase = opts.phase ? ` --phase ${opts.phase}` : '';
  return `${bin} ${opts.verb}${phase} --adapter ${opts.adapter} ${HOOK_SENTINEL}`;
}
