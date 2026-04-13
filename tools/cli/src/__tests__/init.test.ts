import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { patchClaudeConfig, buildMcpEntry, type ClaudeMcpEntry } from '../init.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-test-'));
  configPath = path.join(tmpDir, '.claude.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const entry: ClaudeMcpEntry = {
  command: 'npx',
  args: ['-y', '@second-brain/mcp-server'],
  env: { BRAIN_DB_PATH: '/tmp/test.db' },
};

describe('buildMcpEntry', () => {
  it('constructs the MCP entry with the DB path piped through env', () => {
    const e = buildMcpEntry('/home/user/.second-brain/personal.db');
    expect(e.command).toBe('npx');
    expect(e.args).toEqual(['-y', '@second-brain/mcp-server']);
    expect(e.env?.BRAIN_DB_PATH).toBe('/home/user/.second-brain/personal.db');
  });
});

describe('patchClaudeConfig', () => {
  it('creates a fresh config when the file is missing', () => {
    expect(fs.existsSync(configPath)).toBe(false);
    patchClaudeConfig(configPath, entry);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers['second-brain']).toEqual(entry);
  });

  it('preserves unrelated top-level fields when patching', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        theme: 'dark',
        editor: { fontSize: 14 },
        mcpServers: { 'other-server': { command: 'other' } },
      }),
    );
    patchClaudeConfig(configPath, entry);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.editor).toEqual({ fontSize: 14 });
    expect(written.mcpServers['other-server']).toEqual({ command: 'other' });
    expect(written.mcpServers['second-brain']).toEqual(entry);
  });

  it('overwrites an existing second-brain entry rather than duplicating', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { 'second-brain': { command: 'old', args: [] } },
      }),
    );
    patchClaudeConfig(configPath, entry);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers['second-brain']).toEqual(entry);
    expect(Object.keys(written.mcpServers)).toEqual(['second-brain']);
  });

  it('backs up the original file before writing', () => {
    const original = JSON.stringify({ mcpServers: {} });
    fs.writeFileSync(configPath, original);
    patchClaudeConfig(configPath, entry);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('.claude.json.bak-'));
    expect(backups.length).toBe(1);
    const backup = fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8');
    expect(backup).toBe(original);
  });

  it('backs up even when the original is unparseable and proceeds with fresh config', () => {
    const garbage = '{ not: valid json';
    fs.writeFileSync(configPath, garbage);
    patchClaudeConfig(configPath, entry);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('.claude.json.bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers['second-brain']).toEqual(entry);
  });

  it('is idempotent — calling twice with the same entry yields the same server record', () => {
    patchClaudeConfig(configPath, entry);
    patchClaudeConfig(configPath, entry);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['second-brain']);
    expect(written.mcpServers['second-brain']).toEqual(entry);
  });
});
