/**
 * Adapter interface shared by all per-assistant installers.
 */

export type AdapterName = 'claude' | 'cursor' | 'codex' | 'copilot';

export type AdapterScope = 'user' | 'project';

export interface AdapterInstallOptions {
  scope: AdapterScope;
  cwd: string;
  home: string;
  /** Override the binary name. Defaults to `brain-hook`. */
  hookCommand?: string;
  /** Optional bearer token (used for adapter-side smoke tests / MCP wiring). */
  bearerToken?: string;
  /** When true, abort if claude-mem (or analogous) is already present. */
  skipIfClaudeMem?: boolean;
  /** When true, strip claude-mem entries (Claude only). */
  exclusive?: boolean;
}

export interface AdapterInstallResult {
  /** Primary config file path written. */
  configPath: string;
  /** Hook events that were newly added (empty if all were already present). */
  addedEvents: string[];
  /** Any auxiliary files written (rules file, MCP config, sidecar, etc.). */
  auxFiles: string[];
  /** Backup path of any pre-existing config we replaced. */
  backupPath?: string;
  /** Set when the adapter intentionally chose not to install. */
  skipped?: string;
  /** Free-form warnings surfaced to the user. */
  warnings: string[];
}

export interface AdapterUninstallOptions {
  scope: AdapterScope;
  cwd: string;
  home: string;
}

export interface AdapterUninstallResult {
  configPath: string;
  removed: string[];
  warnings: string[];
}

export interface AdapterDetectResult {
  installed: boolean;
  version?: string;
  warnings: string[];
}

export interface Adapter {
  name: AdapterName;
  supportsPreContextInjection: boolean;
  supportsPromptSubmitInjection: boolean;
  supportsSessionStartInjection: boolean;
  install(opts: AdapterInstallOptions): AdapterInstallResult;
  uninstall(opts: AdapterUninstallOptions): AdapterUninstallResult;
  detect(home: string, cwd: string): AdapterDetectResult;
}

/** Sentinel marker injected into every generated hook command for stable dedup. */
export const HOOK_SENTINEL = '# brain:v2';
