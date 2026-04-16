import { argon2id } from '@noble/hashes/argon2';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa';
import { randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('SBP1');
const SALT_LEN = 16;
const NONCE_LEN = 24;
const KEY_LEN = 32;
const ARGON2_TIME = 3;
const ARGON2_MEM = 65536; // 64 MB in KB

export async function encryptBundle(
  json: string,
  passphrase: string,
): Promise<Buffer> {
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = argon2id(new TextEncoder().encode(passphrase), salt, {
    t: ARGON2_TIME,
    m: ARGON2_MEM,
    p: 1,
    dkLen: KEY_LEN,
  });
  const plaintext = new TextEncoder().encode(json);
  const cipher = xsalsa20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return Buffer.concat([MAGIC, salt, nonce, Buffer.from(ciphertext)]);
}

export async function decryptBundle(
  buf: Buffer,
  passphrase: string,
): Promise<string> {
  if (buf.length < 4 || buf.subarray(0, 4).toString() !== 'SBP1') {
    throw new Error('Invalid bundle format: missing SBP1 magic header');
  }
  const salt = buf.subarray(4, 4 + SALT_LEN);
  const nonce = buf.subarray(4 + SALT_LEN, 4 + SALT_LEN + NONCE_LEN);
  const ciphertext = buf.subarray(4 + SALT_LEN + NONCE_LEN);
  if (ciphertext.length === 0) {
    throw new Error('Invalid bundle format: empty ciphertext');
  }
  const key = argon2id(new TextEncoder().encode(passphrase), salt, {
    t: ARGON2_TIME,
    m: ARGON2_MEM,
    p: 1,
    dkLen: KEY_LEN,
  });
  const cipher = xsalsa20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

export function isEncryptedBundle(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).toString() === 'SBP1';
}
