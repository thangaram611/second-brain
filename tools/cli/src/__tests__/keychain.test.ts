import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  storeSecret,
  readSecret,
  deleteSecret,
  resolveSecret,
  activeBackend,
  resetKeychainCache,
  setKeychainTestOverride,
} from '../keychain.js';
import { setMacKeychainProbeForTest, resetMacKeychainProbeCache } from '../probe-mac-keychain.js';

const ORIG_HOME = process.env.HOME;
let tmpHome: string;

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
  };
}

beforeEach(() => {
  resetKeychainCache();
  resetMacKeychainProbeCache();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-keychain-home-'));
  process.env.HOME = tmpHome;
  delete process.env.TEST_SECRET_ENV;
  // Default the macOS probe to "healthy" so tests reach the keytar stub
  // deterministically. Tests that want probe-fail set false explicitly.
  setMacKeychainProbeForTest(true);
});

afterEach(() => {
  setKeychainTestOverride(null);
  setMacKeychainProbeForTest(null);
  resetMacKeychainProbeCache();
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.TEST_SECRET_ENV;
});

describe('keychain dispatcher — probe-then-pick auto-selection', () => {
  it('healthy probe + working keytar → keychain backend', async () => {
    setKeychainTestOverride(inMemoryKeytar());
    const backend = await activeBackend();
    expect(backend).toBe('keychain');

    const stored = await storeSecret('gitlab.pat:example', 'glpat-xyz');
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.backend).toBe('keychain');

    const read = await readSecret('gitlab.pat:example');
    if (read.ok) {
      expect(read.value).toBe('glpat-xyz');
      expect(read.backend).toBe('keychain');
    }
  });

  it('probe-fail on darwin → file backend (no env, no warning)', async () => {
    if (process.platform !== 'darwin') return;
    setMacKeychainProbeForTest(false);
    setKeychainTestOverride(inMemoryKeytar());
    const backend = await activeBackend();
    expect(backend).toBe('file');

    const stored = await storeSecret('gitlab.pat:example', 'glpat-fallback');
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.backend).toBe('file');

    const read = await readSecret('gitlab.pat:example');
    if (read.ok) expect(read.value).toBe('glpat-fallback');
  });

  it('keytar runtime error → file backend (silent fallback)', async () => {
    setKeychainTestOverride({
      setPassword: async (): Promise<void> => { throw new Error('keychain locked'); },
      getPassword: async (): Promise<string | null> => null,
      deletePassword: async (): Promise<boolean> => false,
    });

    const stored = await storeSecret('gitlab.pat:example', 'glpat-runtime-error');
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.backend).toBe('file');

    const read = await readSecret('gitlab.pat:example');
    if (read.ok) expect(read.value).toBe('glpat-runtime-error');
  });

  it('module-missing → file backend (silent fallback)', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'module-missing',
      message: 'keytar not installed',
    });
    const stored = await storeSecret('gitlab.pat:example', 'glpat-no-keytar');
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.backend).toBe('file');

    const removed = await deleteSecret('gitlab.pat:example');
    if (removed.ok) expect(removed.value).toBe(true);
  });
});

describe('resolveSecret env-var escape hatch', () => {
  it('returns the env-var value when no secret exists in either backend', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'module-missing',
      message: 'keytar not installed',
    });
    process.env.TEST_SECRET_ENV = 'from-env';

    const resolved = await resolveSecret('gitlab.pat:whatever', 'TEST_SECRET_ENV');
    expect(resolved.value).toBe('from-env');
    expect(resolved.source).toBe('env');
  });

  it('prefers the stored value over the env var', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'module-missing',
      message: 'keytar not installed',
    });
    process.env.TEST_SECRET_ENV = 'from-env';
    await storeSecret('gitlab.pat:whatever', 'from-file');

    const resolved = await resolveSecret('gitlab.pat:whatever', 'TEST_SECRET_ENV');
    expect(resolved.value).toBe('from-file');
    expect(resolved.source).toBe('file');
  });

  it('returns null with source=null when no secret exists and no env var is set', async () => {
    setKeychainTestOverride({
      ok: false,
      reason: 'module-missing',
      message: 'keytar not installed',
    });
    delete process.env.TEST_SECRET_ENV;

    const resolved = await resolveSecret('gitlab.pat:whatever', 'TEST_SECRET_ENV');
    expect(resolved.value).toBeNull();
    expect(resolved.source).toBeNull();
  });
});
