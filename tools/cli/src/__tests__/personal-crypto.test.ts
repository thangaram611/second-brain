import { describe, it, expect } from 'vitest';
import {
  encryptBundle,
  decryptBundle,
  isEncryptedBundle,
} from '../personal-crypto.js';

describe('personal-crypto', () => {
  const sampleJson = JSON.stringify({ entities: [{ id: '01J1', name: 'test' }] });
  const passphrase = 'correct-horse-battery-staple';

  it('round-trip: encrypt then decrypt returns original JSON', async () => {
    const encrypted = await encryptBundle(sampleJson, passphrase);
    const decrypted = await decryptBundle(encrypted, passphrase);
    expect(decrypted).toBe(sampleJson);
  });

  it('wrong passphrase throws an error', async () => {
    const encrypted = await encryptBundle(sampleJson, passphrase);
    await expect(decryptBundle(encrypted, 'wrong-passphrase')).rejects.toThrow();
  });

  it('corrupted data throws an error', async () => {
    const encrypted = await encryptBundle(sampleJson, passphrase);
    // Flip a byte in the ciphertext region
    const corrupted = Buffer.from(encrypted);
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(decryptBundle(corrupted, passphrase)).rejects.toThrow();
  });

  it('isEncryptedBundle returns true for encrypted buffer', async () => {
    const encrypted = await encryptBundle(sampleJson, passphrase);
    expect(isEncryptedBundle(encrypted)).toBe(true);
  });

  it('isEncryptedBundle returns false for plain JSON', () => {
    const plain = Buffer.from(sampleJson);
    expect(isEncryptedBundle(plain)).toBe(false);
  });

  it('isEncryptedBundle returns false for empty buffer', () => {
    expect(isEncryptedBundle(Buffer.alloc(0))).toBe(false);
  });

  it('different passphrases produce different ciphertexts', async () => {
    const enc1 = await encryptBundle(sampleJson, 'pass-a');
    const enc2 = await encryptBundle(sampleJson, 'pass-b');
    expect(enc1.equals(enc2)).toBe(false);
  });

  it('same passphrase produces different ciphertexts (random salt/nonce)', async () => {
    const enc1 = await encryptBundle(sampleJson, passphrase);
    const enc2 = await encryptBundle(sampleJson, passphrase);
    expect(enc1.equals(enc2)).toBe(false);
  });

  it('empty string input works', async () => {
    const encrypted = await encryptBundle('', passphrase);
    const decrypted = await decryptBundle(encrypted, passphrase);
    expect(decrypted).toBe('');
  });

  it('rejects buffer without SBP1 magic header', async () => {
    const bad = Buffer.from('NOT_A_BUNDLE_AT_ALL');
    await expect(decryptBundle(bad, passphrase)).rejects.toThrow(
      'Invalid bundle format: missing SBP1 magic header',
    );
  });

  it('rejects buffer too short to contain header', async () => {
    await expect(decryptBundle(Buffer.from('SB'), passphrase)).rejects.toThrow(
      'Invalid bundle format: missing SBP1 magic header',
    );
  });
});
