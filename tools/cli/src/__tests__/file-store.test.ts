import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileStoreSet, fileStoreGet, fileStoreDelete, fileStorePath } from '../file-store.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-file-store-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('file-store', () => {
  it('round-trip: set then get returns the same secret', async () => {
    await fileStoreSet('pat:localhost:7430:abc', 'sbp_secret_value', home);
    const got = await fileStoreGet('pat:localhost:7430:abc', home);
    expect(got).toBe('sbp_secret_value');
  });

  it('writes file with 0600 perms and parent dir with 0700 perms', async () => {
    await fileStoreSet('pat:localhost:7430:abc', 'sbp_secret_value', home);
    const file = fileStorePath('pat:localhost:7430:abc', home);
    const fileStat = fs.statSync(file);
    expect((fileStat.mode & 0o777).toString(8)).toBe('600');
    const dirStat = fs.statSync(path.dirname(file));
    expect((dirStat.mode & 0o777).toString(8)).toBe('700');
  });

  it('returns null for a missing account', async () => {
    const got = await fileStoreGet('pat:never:stored', home);
    expect(got).toBeNull();
  });

  it('refuses a file whose recorded account does not match the requested account', async () => {
    // Manually plant a file at the hash slot for account A but with
    // payload claiming account B. This catches rename / copy attacks.
    await fileStoreSet('pat:host:A', 'value-A', home);
    const aPath = fileStorePath('pat:host:A', home);
    const bPath = fileStorePath('pat:host:B', home);
    fs.copyFileSync(aPath, bPath);
    // bPath's payload still says account=pat:host:A — refuse to serve.
    const got = await fileStoreGet('pat:host:B', home);
    expect(got).toBeNull();
  });

  it('returns null for a corrupted file (bad JSON or bad schema)', async () => {
    await fileStoreSet('pat:host:A', 'value-A', home);
    const file = fileStorePath('pat:host:A', home);
    fs.writeFileSync(file, '{ not json');
    expect(await fileStoreGet('pat:host:A', home)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ v: 1, account: 'pat:host:A' })); // missing secret
    expect(await fileStoreGet('pat:host:A', home)).toBeNull();
  });

  it('delete removes the file and is idempotent', async () => {
    await fileStoreSet('pat:host:A', 'value-A', home);
    expect(await fileStoreDelete('pat:host:A', home)).toBe(true);
    expect(await fileStoreDelete('pat:host:A', home)).toBe(false);
    expect(await fileStoreGet('pat:host:A', home)).toBeNull();
  });

  it('atomic write: never leaves a half-written file on the final path', async () => {
    await fileStoreSet('pat:host:A', 'value-1', home);
    await fileStoreSet('pat:host:A', 'value-2', home);
    expect(await fileStoreGet('pat:host:A', home)).toBe('value-2');
    // Verify no .tmp.* sibling lingers.
    const dir = path.dirname(fileStorePath('pat:host:A', home));
    const siblings = fs.readdirSync(dir);
    expect(siblings.filter((s) => s.includes('.tmp.'))).toHaveLength(0);
  });
});
