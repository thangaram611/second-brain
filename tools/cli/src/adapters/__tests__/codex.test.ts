import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { codexAdapter, upsertCodexConfigToml } from '../codex.js';
import { HOOK_SENTINEL } from '../types.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('codexAdapter — install', () => {
  it('writes hooks.json at user scope and config.toml flag', () => {
    const result = codexAdapter.install({ scope: 'user', home, cwd });
    expect(result.configPath).toBe(path.join(home, '.codex', 'hooks.json'));
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(raw.hooks.SessionStart[0].hooks[0].command).toContain('--adapter codex');
    expect(raw.hooks.SessionStart[0].hooks[0].command).toContain(HOOK_SENTINEL);

    const tomlPath = path.join(home, '.codex', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const toml = fs.readFileSync(tomlPath, 'utf8');
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
    expect(toml).toMatch(/\[mcp_servers\.second-brain\]/);
  });

  it('is idempotent', () => {
    codexAdapter.install({ scope: 'user', home, cwd });
    const second = codexAdapter.install({ scope: 'user', home, cwd });
    expect(second.addedEvents).toEqual([]);
    // config.toml should be unchanged on second run
    const tomlPath = path.join(home, '.codex', 'config.toml');
    const before = fs.readFileSync(tomlPath, 'utf8');
    codexAdapter.install({ scope: 'user', home, cwd });
    const after = fs.readFileSync(tomlPath, 'utf8');
    expect(after).toBe(before);
  });

  it('uninstall removes sentinel entries', () => {
    codexAdapter.install({ scope: 'user', home, cwd });
    const result = codexAdapter.uninstall({ scope: 'user', home, cwd });
    expect(result.removed.length).toBeGreaterThan(0);
  });
});

describe('upsertCodexConfigToml', () => {
  it('adds [features] block to empty file', () => {
    const { next, changed } = upsertCodexConfigToml('');
    expect(changed).toBe(true);
    expect(next).toMatch(/\[features\]/);
    expect(next).toMatch(/codex_hooks\s*=\s*true/);
  });

  it('adds the flag to an existing [features] block', () => {
    const initial = '[features]\nother = false\n';
    const { next, changed } = upsertCodexConfigToml(initial);
    expect(changed).toBe(true);
    expect(next).toMatch(/codex_hooks\s*=\s*true/);
    expect(next).toMatch(/other = false/);
  });

  it('is idempotent', () => {
    const { next: a, changed: c1 } = upsertCodexConfigToml('');
    expect(c1).toBe(true);
    const { next: b, changed: c2 } = upsertCodexConfigToml(a);
    expect(c2).toBe(false);
    expect(b).toBe(a);
  });

  it('preserves existing mcp_servers blocks', () => {
    const initial = '[mcp_servers.other]\ncommand = "other"\n';
    const { next } = upsertCodexConfigToml(initial);
    expect(next).toMatch(/\[mcp_servers\.other\]/);
    expect(next).toMatch(/\[mcp_servers\.second-brain\]/);
  });
});
