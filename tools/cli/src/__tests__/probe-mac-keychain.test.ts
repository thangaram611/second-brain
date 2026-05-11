import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  probeMacKeychain,
  resetMacKeychainProbeCache,
  setMacKeychainProbeForTest,
} from '../probe-mac-keychain.js';

beforeEach(() => {
  resetMacKeychainProbeCache();
});

afterEach(() => {
  setMacKeychainProbeForTest(null);
  resetMacKeychainProbeCache();
});

describe('probeMacKeychain', () => {
  it('returns false in SSH context without invoking the security CLI', async () => {
    const result = await probeMacKeychain({ sshTty: '/dev/ttys000' });
    expect(result).toBe(false);
  });

  it('returns false when SSH_CONNECTION is set', async () => {
    const result = await probeMacKeychain({ sshConnection: '1.2.3.4 22 5.6.7.8 22' });
    expect(result).toBe(false);
  });

  it('returns the injected result when provided (test override)', async () => {
    expect(await probeMacKeychain({ injectedResult: true })).toBe(true);
    resetMacKeychainProbeCache();
    expect(await probeMacKeychain({ injectedResult: false })).toBe(false);
  });

  it('memoizes — second call returns the cached value without re-probing', async () => {
    await probeMacKeychain({ injectedResult: true });
    // Even if a later call asks for false, the cache wins.
    const second = await probeMacKeychain({ injectedResult: false });
    expect(second).toBe(true);
  });

  it('resetMacKeychainProbeCache lets the next call re-probe', async () => {
    await probeMacKeychain({ injectedResult: true });
    resetMacKeychainProbeCache();
    expect(await probeMacKeychain({ injectedResult: false })).toBe(false);
  });

  it('setMacKeychainProbeForTest presets the cached value for the dispatcher path', async () => {
    setMacKeychainProbeForTest(true);
    // No injectedResult passed — dispatcher-style call.
    expect(await probeMacKeychain()).toBe(true);
    setMacKeychainProbeForTest(false);
    expect(await probeMacKeychain()).toBe(false);
  });
});
