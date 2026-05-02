/**
 * Per-assistant adapter interface (PR3 §C).
 *
 * Each adapter encapsulates the assistant-specific config-file shape, scope
 * rules, and capability matrix. The unified `wire-assistant` command walks
 * this registry; per-adapter failures degrade to warnings.
 */

import type { AdapterName as _AdapterName } from './types.js';

export type { AdapterName } from './types.js';
export type { Adapter, AdapterInstallOptions, AdapterInstallResult, AdapterUninstallResult, AdapterDetectResult } from './types.js';

import { claudeAdapter } from './claude.js';
import { cursorAdapter } from './cursor.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import type { Adapter } from './types.js';

export const ADAPTERS: Record<_AdapterName, Adapter> = {
  claude: claudeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
};

export function getAdapter(name: _AdapterName): Adapter {
  return ADAPTERS[name];
}

export const ALL_ADAPTER_NAMES: _AdapterName[] = ['claude', 'cursor', 'codex', 'copilot'];
