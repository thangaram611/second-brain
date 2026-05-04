import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeCredentials,
  readCredentials,
  listCredentials,
  deleteCredentials,
  credentialsPath,
  credentialsDir,
  type CredentialsRecord,
} from '../credentials.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-credentials-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE: CredentialsRecord = {
  serverUrl: 'https://api.example.com',
  namespace: 'team-graph',
  userId: 'usr_1234567890abcdef',
  email: 'alice@example.com',
  defaultTokenId: 'aaaaaaaa',
  hookTokenId: 'bbbbbbbb',
  cliTokenId: 'cccccccc',
  redeemedAt: '2026-05-02T12:00:00.000Z',
  patExpiresAt: '2026-08-02T12:00:00.000Z',
};

describe('writeCredentials + readCredentials', () => {
  it('round-trips a valid record', () => {
    const { path: written } = writeCredentials('api.example.com', SAMPLE, tmp);
    expect(written).toBe(credentialsPath('api.example.com', tmp));
    const loaded = readCredentials('api.example.com', tmp);
    expect(loaded).toEqual(SAMPLE);
  });

  it('writes the file with mode 0600 on POSIX', () => {
    if (process.platform === 'win32') return;
    const { path: written } = writeCredentials('api.example.com', SAMPLE, tmp);
    const mode = fs.statSync(written).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the parent dir with mode 0700 on POSIX', () => {
    if (process.platform === 'win32') return;
    writeCredentials('api.example.com', SAMPLE, tmp);
    const mode = fs.statSync(credentialsDir(tmp)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('rejects malformed write input via the schema', () => {
    const bad = { ...SAMPLE, serverUrl: 'not-a-url' };
    expect(() =>
      // safe-cast through unknown so the test exercises the runtime guard
      // rather than the compile-time guard.
      writeCredentials('api.example.com', bad as unknown as CredentialsRecord, tmp),
    ).toThrow();
  });

  it('returns null on missing file', () => {
    expect(readCredentials('absent.example.com', tmp)).toBeNull();
  });

  it('returns null on malformed JSON (does not throw)', () => {
    const dir = credentialsDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.example.com.json'), '{ broken');
    expect(readCredentials('bad.example.com', tmp)).toBeNull();
  });

  it('returns null on schema mismatch', () => {
    const dir = credentialsDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bad.example.com.json'),
      JSON.stringify({ serverUrl: 'ftp://x' }),
    );
    expect(readCredentials('bad.example.com', tmp)).toBeNull();
  });
});

describe('listCredentials', () => {
  it('returns all valid records and skips invalid ones', () => {
    writeCredentials('a.example.com', SAMPLE, tmp);
    writeCredentials('b.example.com', { ...SAMPLE, namespace: 'other' }, tmp);

    // Drop a corrupt file alongside.
    const dir = credentialsDir(tmp);
    fs.writeFileSync(path.join(dir, 'corrupt.example.com.json'), '{ not json');

    const list = listCredentials(tmp);
    expect(list.map((e) => e.host).sort()).toEqual(['a.example.com', 'b.example.com']);
    expect(list.find((e) => e.host === 'b.example.com')!.record.namespace).toBe('other');
  });

  it('returns empty when the dir is missing', () => {
    expect(listCredentials(tmp)).toEqual([]);
  });

  it('skips dotfiles (atomic-write tmp files)', () => {
    const dir = credentialsDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.foo.json.abcd1234.tmp'),
      JSON.stringify(SAMPLE),
    );
    expect(listCredentials(tmp)).toEqual([]);
  });
});

describe('deleteCredentials', () => {
  it('removes the file when present', () => {
    writeCredentials('a.example.com', SAMPLE, tmp);
    expect(readCredentials('a.example.com', tmp)).not.toBeNull();
    deleteCredentials('a.example.com', tmp);
    expect(readCredentials('a.example.com', tmp)).toBeNull();
  });

  it('is a no-op when absent', () => {
    expect(() => deleteCredentials('absent.example.com', tmp)).not.toThrow();
  });
});
