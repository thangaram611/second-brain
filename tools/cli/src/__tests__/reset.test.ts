import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findLatestClaudeBackup, restoreOrClearClaudeConfig } from '../reset.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-reset-test-'));
  configPath = path.join(tmpDir, '.claude.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findLatestClaudeBackup', () => {
  it('returns null when no backups exist', () => {
    expect(findLatestClaudeBackup(configPath)).toBeNull();
  });

  it('returns the most-recently-modified backup', () => {
    fs.writeFileSync(`${configPath}.bak-2025-01-01T00-00-00-000Z`, '{"a":1}');
    fs.writeFileSync(`${configPath}.bak-2025-02-01T00-00-00-000Z`, '{"a":2}');
    // Tie-break by mtime, not name.
    const newer = `${configPath}.bak-2025-02-01T00-00-00-000Z`;
    const future = Date.now() / 1000 + 10;
    fs.utimesSync(newer, future, future);
    expect(findLatestClaudeBackup(configPath)).toBe(newer);
  });
});

describe('restoreOrClearClaudeConfig', () => {
  it('restores file contents from the most recent backup', () => {
    fs.writeFileSync(configPath, '{"mcpServers":{"second-brain":{"x":1}}}');
    fs.writeFileSync(`${configPath}.bak-1`, '{"original":true}');
    const result = restoreOrClearClaudeConfig(configPath);
    expect(result.action).toBe('restored');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"original":true}');
  });

  it('strips the second-brain entry when no backup exists', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ theme: 'dark', mcpServers: { 'second-brain': { x: 1 }, other: { y: 2 } } }),
    );
    const result = restoreOrClearClaudeConfig(configPath);
    expect(result.action).toBe('cleared');
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.mcpServers['second-brain']).toBeUndefined();
    expect(written.mcpServers.other).toEqual({ y: 2 });
  });

  it('is a no-op when the live file has no second-brain entry and no backup exists', () => {
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));
    const result = restoreOrClearClaudeConfig(configPath);
    expect(result.action).toBe('missing');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"theme":"dark"}');
  });

  it('leaves unparseable files untouched rather than silently rewriting them', () => {
    const garbage = '{ not json';
    fs.writeFileSync(configPath, garbage);
    const result = restoreOrClearClaudeConfig(configPath);
    expect(result.action).toBe('missing');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(garbage);
  });
});
