/**
 * OS-keychain wrapper for Phase 10.3 secrets (GitLab PAT + per-project
 * webhook shared-secrets). `keytar` is an `optionalDependencies` entry
 * so install can succeed on headless Linux CI without `libsecret`.
 *
 * Two failure modes are handled distinctly (plan revision #11):
 *   — `keytar` module not installed → `KeychainUnavailable { reason:
 *     'module-missing' }`. No security surface ever existed on this
 *     host; the caller's env-var fallback is taken automatically.
 *   — `keytar` installed but throws at runtime (libsecret missing on
 *     Linux, macOS keychain locked, user denied the prompt) →
 *     `KeychainUnavailable { reason: 'runtime-error', cause }`. The
 *     user expected encrypted storage, so silent fallback is a real
 *     security downgrade. Callers fall back ONLY when
 *     `SECOND_BRAIN_REQUIRE_KEYCHAIN` is NOT `'1'`; setting it to `'1'`
 *     forces a hard failure on strict hosts (CI / shared boxes).
 *
 * The module exports three primitives — `storeSecret`, `readSecret`,
 * `deleteSecret` — each returning a discriminated `KeychainResult`.
 * Callers inspect `.ok` and handle the downgrade explicitly.
 */

export const KEYCHAIN_SERVICE = 'second-brain';

export type KeychainUnavailableReason = 'module-missing' | 'runtime-error';

export interface KeychainUnavailable {
  ok: false;
  reason: KeychainUnavailableReason;
  message: string;
}

export interface KeychainOk<T> {
  ok: true;
  value: T;
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
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof (candidate as KeytarLike).setPassword !== 'function'
    ) {
      cached = {
        ok: false,
        reason: 'module-missing',
        message: 'keytar module loaded but did not expose the expected API',
      };
      return cached;
    }
    cached = { keytar: candidate as KeytarLike };
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

function runtimeError(op: string, err: unknown): KeychainUnavailable {
  return {
    ok: false,
    reason: 'runtime-error',
    message: `keytar.${op}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** For tests — resets the module-load cache. */
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

export async function storeSecret(account: string, password: string): Promise<KeychainResult<true>> {
  const state = await loadKeytar();
  if ('ok' in state) return state;
  try {
    await state.keytar.setPassword(KEYCHAIN_SERVICE, account, password);
    return { ok: true, value: true };
  } catch (err) {
    return runtimeError('setPassword', err);
  }
}

export async function readSecret(account: string): Promise<KeychainResult<string | null>> {
  const state = await loadKeytar();
  if ('ok' in state) return state;
  try {
    const value = await state.keytar.getPassword(KEYCHAIN_SERVICE, account);
    return { ok: true, value };
  } catch (err) {
    return runtimeError('getPassword', err);
  }
}

export async function deleteSecret(account: string): Promise<KeychainResult<boolean>> {
  const state = await loadKeytar();
  if ('ok' in state) return state;
  try {
    const removed = await state.keytar.deletePassword(KEYCHAIN_SERVICE, account);
    return { ok: true, value: removed };
  } catch (err) {
    return runtimeError('deletePassword', err);
  }
}

/**
 * Resolve a secret from keychain, falling back to the named env var if
 * keychain is unavailable. Policy split by `reason`:
 *   — `module-missing` → env-var fallback is taken automatically; no
 *     security surface ever existed on this host.
 *   — `runtime-error` → keytar was installed but threw. If
 *     `SECOND_BRAIN_REQUIRE_KEYCHAIN === '1'` we refuse env fallback
 *     (`{ value: null, … }`); otherwise we surface the env value with
 *     `unavailable` populated so callers can warn.
 *
 * Returns `{ value, source: 'keychain' | 'env' | null }` plus the
 * original `KeychainUnavailable` (if any) so callers can surface it.
 */
export async function resolveSecret(
  account: string,
  envVar: string,
): Promise<{
  value: string | null;
  source: 'keychain' | 'env' | null;
  unavailable: KeychainUnavailable | null;
}> {
  const res = await readSecret(account);
  if (res.ok) {
    return { value: res.value, source: res.value === null ? null : 'keychain', unavailable: null };
  }
  const envValue = process.env[envVar];
  if (envValue === undefined) {
    return { value: null, source: null, unavailable: res };
  }
  if (res.reason === 'runtime-error' && process.env.SECOND_BRAIN_REQUIRE_KEYCHAIN === '1') {
    return { value: null, source: null, unavailable: res };
  }
  return { value: envValue, source: 'env', unavailable: res };
}
