/**
 * Back-compat re-exports. The Claude hook installer now lives in
 * `adapters/claude.ts` so the wider per-assistant adapter system can share
 * code (PR3 §C). This module preserves the legacy public surface for any
 * caller that still imports from here (`tests/install-hooks.test.ts`,
 * `wire.ts`).
 */
export {
  installClaudeHooks,
  uninstallClaudeHooks,
  detectClaudeMem,
  stripClaudeMem,
  isClaudeMemCommand,
  CLAUDE_HOOK_EVENTS,
} from './adapters/claude.js';

export type {
  LegacyInstallOptions as InstallHooksOptions,
  LegacyInstallResult as InstallHooksResult,
  ClaudeHookEvent,
} from './adapters/claude.js';

export type HookScope = 'user' | 'project';
export type HookTool = 'claude' | 'codex' | 'copilot' | 'gemini' | 'all';
