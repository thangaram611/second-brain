import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  storeSecret,
  readSecret,
  deleteSecret,
  resolveSecret,
  resetKeychainCache,
  setKeychainTestOverride,
} from '../keychain.js';

function inMemoryKeytar() {
  const store = new Map<string, string>();
  const key = (service: string, account: string): string => `${service}::${account}`;
  return {
    async setPassword(service: string, account: string, password: string): Promise<void> {
      store.set(key(service, account), password);
    },
    async getPassword(service: string, account: string): Promise<string | null> {
      return store.get(key(service, account)) ?? null;
    },
    async deletePassword(service: string, account: string): Promise<boolean> {
      return store.delete(key(service, account));
    },
    _store: store,
  };
}

beforeEach(() => {
  resetKeychainCache();
  delete process.env.SECOND_BRAIN_ALLOW_PLAINTEXT_PAT;
  delete process.env.TEST_SECRET_ENV;
});

afterEach(() => {
  setKeychainTestOverride(null);
  delete process.env.SECOND_BRAIN_ALLOW_PLAINTEXT_PAT;
  delete process.env.TEST_SECRET_ENV;
});

describe('keychain helpers', () => {
  it('store/read/delete round-trip via an in-memory keytar stub', async () => {
    setKeychainTestOverride(inMemoryKeytar());

    const stored = await storeSecret('gitlab.pat:example', 'glpat-abc');
    expect(stored.ok).toBe(true);

    const read = await readSecret('gitlab.pat:example');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toBe('glpat-abc');

    const removed = await deleteSecret('gitlab.pat:example');
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toBe(true);

    const afterDelete = await readSecret('gitlab.pat:example');
    if (afterDelete.ok) expect(afterDelete.value).toBeNull();
  });

  it('module-missing falls back to env var silently via resolveSecret', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'module-missing',
      message: 'keytar not installed',
    });
    process.env.TEST_SECRET_ENV = 'from-env';

    const resolved = await resolveSecret('gitlab.pat:whatever', 'TEST_SECRET_ENV');
    expect(resolved.value).toBe('from-env');
    expect(resolved.source).toBe('env');
    expect(resolved.unavailable?.reason).toBe('module-missing');
  });

  it('runtime-error refuses env-var fallback without SECOND_BRAIN_ALLOW_PLAINTEXT_PAT=1', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'runtime-error',
      message: 'keychain is locked',
    });
    process.env.TEST_SECRET_ENV = 'from-env';

    const resolved = await resolveSecret('gitlab.pat:whatever', 'TEST_SECRET_ENV');
    expect(resolved.value).toBeNull();
    expect(resolved.source).toBeNull();
    expect(resolved.unavailable?.reason).toBe('runtime-error');
  });

  it('runtime-error with opt-in env=1 accepts env-var fallback', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'runtime-error',
      message: 'keychain is locked',
    });
    process.env.TEST_SECRET_ENV = 'from-env';
    process.env.SECOND_BRAIN_ALLOW_PLAINTEXT_PAT = '1';

    const resolved = await resolveSecret('gitlab.pat:whatever', 'TEST_SECRET_ENV');
    expect(resolved.value).toBe('from-env');
    expect(resolved.source).toBe('env');
    expect(resolved.unavailable?.reason).toBe('runtime-error');
  });
});
