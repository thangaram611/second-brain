/**
 * Secret storage dispatcher — routes `storeSecret`/`readSecret`/
 * `deleteSecret` to either the OS keychain (keytar) or a 0600 file
 * (`file-store.ts`) based on platform + opt-in.
 *
 * Why a dispatcher and not just keytar?
 *   macOS's legacy keychain API (the only one reachable from an unsigned
 *   Node CLI) pops a system-modal "Keychain Not Found / Reset to Defaults"
 *   dialog when the user's login keychain is unhealthy. The dialog is
 *   rendered by the Security framework BEFORE `keytar.setPassword` returns,
 *   so error-handling can't suppress it, and the "Reset to Defaults"
 *   button is destructive (wipes the user's iCloud/Safari/Mail creds).
 *
 *   The data-protection keychain (the modern, non-popping path) requires a
 *   signed binary with a keychain-access-group entitlement — unreachable
 *   for an npm-distributed CLI. So macOS structurally inherits the dialog
 *   problem. VS Code, `gh`, and Claude Code all chose the same mitigation
 *   we're choosing here: default to a 0600 file in `~/.second-brain/`.
 *
 * Backend selection (auto-magic, no user-facing env var):
 *   - macOS                            → probe `security list-keychains`
 *     once per process. Healthy keychain → keychain. Broken/SSH/missing
 *     → file. Result is cached so the probe never repeats mid-session.
 *   - Linux / Windows                  → keychain (libsecret /
 *     CredentialManager — neither pops destructive dialogs on failure);
 *     falls back to file when the native binding is missing.
 *
 * The public `KeychainResult<T>` shape is preserved — callers
 * (`init-client`, `auth-rotate`, `wire`, `unwire`, `resolve-token`,
 * `doctor`) keep working without churn. `KeychainOk` now always carries
 * the `backend` field so `init-client` can print which path was used.
 */

import {
  fileStoreSet,
  fileStoreGet,
  fileStoreDelete,
} from './file-store.js';
import { probeMacKeychain } from './probe-mac-keychain.js';

export const KEYCHAIN_SERVICE = 'second-brain';

export type StorageBackend = 'keychain' | 'file';

export type KeychainUnavailableReason = 'module-missing' | 'runtime-error';

export interface KeychainUnavailable {
  ok: false;
  reason: KeychainUnavailableReason;
  message: string;
}

export interface KeychainOk<T> {
  ok: true;
  value: T;
  /** Which backend actually serviced the call. */
  backend: StorageBackend;
}

export type KeychainResult<T> = KeychainOk<T> | KeychainUnavailable;

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let cached: { keytar: KeytarLike } | KeychainUnavailable | null = null;

export async function loadKeytar(): Promise<{ keytar: KeytarLike } | KeychainUnavailable> {
  if (cached !== null) return cached;
  try {
    const mod = await import('keytar');
    const ModuleSchema = (m: unknown): m is { default?: unknown } =>
      m !== null && typeof m === 'object';
    const inner: unknown = ModuleSchema(mod)
      ? ((mod as { default?: unknown }).default ?? mod)
      : mod;
    if (
      inner === null ||
      typeof inner !== 'object' ||
      typeof (inner as { setPassword?: unknown }).setPassword !== 'function'
    ) {
      cached = {
        ok: false,
        reason: 'module-missing',
        message: 'keytar module loaded but did not expose the expected API',
      };
      return cached;
    }
    cached = { keytar: inner as KeytarLike };
    return cached;
  } catch (err) {
    cached = {
      ok: false,
      reason: 'module-missing',
      message: err instanceof Error ? err.message : 'keytar import failed',
    };
    return cached;
  }
}

function runtimeErrorOf(op: string, err: unknown): KeychainUnavailable {
  return {
    ok: false,
    reason: 'runtime-error',
    message: `keytar.${op}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** For tests — resets the keytar module-load cache. */
export function resetKeychainCache(): void {
  cached = null;
}

/** For tests — inject a stub keytar implementation or a failure. */
export function setKeychainTestOverride(
  override: KeytarLike | KeychainUnavailable | null,
): void {
  if (override === null) {
    cached = null;
  } else if ('ok' in override) {
    cached = override;
  } else {
    cached = { keytar: override };
  }
}

async function selectBackend(): Promise<StorageBackend> {
  if (process.platform === 'darwin') {
    const probeOk = await probeMacKeychain();
    return probeOk ? 'keychain' : 'file';
  }
  return 'keychain';
}

/** Public query — which backend would `storeSecret` use right now? */
export async function activeBackend(): Promise<StorageBackend> {
  return selectBackend();
}

export async function storeSecret(
  account: string,
  password: string,
): Promise<KeychainResult<true>> {
  const backend = await selectBackend();
  if (backend === 'file') {
    await fileStoreSet(account, password);
    return { ok: true, value: true, backend: 'file' };
  }
  const state = await loadKeytar();
  if ('ok' in state) {
    await fileStoreSet(account, password);
    return { ok: true, value: true, backend: 'file' };
  }
  try {
    await state.keytar.setPassword(KEYCHAIN_SERVICE, account, password);
    return { ok: true, value: true, backend: 'keychain' };
  } catch (err) {
    void runtimeErrorOf('setPassword', err);
    await fileStoreSet(account, password);
    return { ok: true, value: true, backend: 'file' };
  }
}

export async function readSecret(
  account: string,
): Promise<KeychainResult<string | null>> {
  const backend = await selectBackend();
  if (backend === 'file') {
    const value = await fileStoreGet(account);
    return { ok: true, value, backend: 'file' };
  }
  const state = await loadKeytar();
  if ('ok' in state) {
    const value = await fileStoreGet(account);
    return { ok: true, value, backend: 'file' };
  }
  try {
    const value = await state.keytar.getPassword(KEYCHAIN_SERVICE, account);
    if (value !== null) return { ok: true, value, backend: 'keychain' };
    const fileValue = await fileStoreGet(account);
    return {
      ok: true,
      value: fileValue,
      backend: fileValue !== null ? 'file' : 'keychain',
    };
  } catch (err) {
    void runtimeErrorOf('getPassword', err);
    const value = await fileStoreGet(account);
    return { ok: true, value, backend: 'file' };
  }
}

export async function deleteSecret(
  account: string,
): Promise<KeychainResult<boolean>> {
  const backend = await selectBackend();
  if (backend === 'file') {
    const removed = await fileStoreDelete(account);
    return { ok: true, value: removed, backend: 'file' };
  }
  const state = await loadKeytar();
  if ('ok' in state) {
    const removed = await fileStoreDelete(account);
    return { ok: true, value: removed, backend: 'file' };
  }
  try {
    const removed = await state.keytar.deletePassword(KEYCHAIN_SERVICE, account);
    const fileRemoved = await fileStoreDelete(account);
    return { ok: true, value: removed || fileRemoved, backend: 'keychain' };
  } catch (err) {
    void runtimeErrorOf('deletePassword', err);
    const removed = await fileStoreDelete(account);
    return { ok: true, value: removed, backend: 'file' };
  }
}

/**
 * Resolve a secret with an env-var escape hatch. Storage now always
 * succeeds, so this only consults the env var when nothing is found in
 * the active backend.
 */
export async function resolveSecret(
  account: string,
  envVar: string,
): Promise<{
  value: string | null;
  source: 'keychain' | 'file' | 'env' | null;
}> {
  const res = await readSecret(account);
  if (res.ok && res.value !== null) {
    return { value: res.value, source: res.backend };
  }
  const envValue = process.env[envVar];
  if (envValue !== undefined && envValue.length > 0) {
    return { value: envValue, source: 'env' };
  }
  return { value: null, source: null };
}
