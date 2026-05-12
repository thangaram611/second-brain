import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { codexAdapter, upsertCodexConfigToml } from '../codex.js';
import { HOOK_SENTINEL } from '../types.js';
import * as mcpResolve from '../mcp-resolve.js';
import type { BrainMcpInvocation } from '../mcp-resolve.js';

let home: string;
let cwd: string;

const fakeInvocation: BrainMcpInvocation = {
  command: '/opt/homebrew/bin/node',
  args: ['/abs/path/to/packages/mcp-server/dist/stdio.mjs'],
};

const fakeInvocationB: BrainMcpInvocation = {
  command: '/Users/x/.volta/bin/node',
  args: ['/abs/path/to/packages/mcp-server/dist/stdio.mjs'],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('codexAdapter — install', () => {
  it('writes hooks.json at user scope and config.toml flag (`hooks = true`, not deprecated `codex_hooks`)', () => {
    const result = codexAdapter.install({ scope: 'user', home, cwd });
    expect(result.configPath).toBe(path.join(home, '.codex', 'hooks.json'));
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(raw.hooks.SessionStart[0].hooks[0].command).toContain('--adapter codex');
    expect(raw.hooks.SessionStart[0].hooks[0].command).toContain(HOOK_SENTINEL);

    const tomlPath = path.join(home, '.codex', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const toml = fs.readFileSync(tomlPath, 'utf8');
    // C1: new flag is `hooks = true`; deprecated `codex_hooks` must NOT appear.
    expect(toml).toMatch(/^hooks\s*=\s*true/m);
    expect(toml).not.toMatch(/codex_hooks/);
    // Managed sentinel + block is present.
    expect(toml).toContain('# >>> second-brain-mcp managed block');
    expect(toml).toMatch(/\[mcp_servers\.second-brain\]/);
  });

  it('is idempotent — second run produces byte-identical config.toml', () => {
    codexAdapter.install({ scope: 'user', home, cwd });
    const tomlPath = path.join(home, '.codex', 'config.toml');
    const before = fs.readFileSync(tomlPath, 'utf8');
    const second = codexAdapter.install({ scope: 'user', home, cwd });
    expect(second.addedEvents).toEqual([]);
    const after = fs.readFileSync(tomlPath, 'utf8');
    expect(after).toBe(before);
  });

  it('uninstall removes sentinel hook entries', () => {
    codexAdapter.install({ scope: 'user', home, cwd });
    const result = codexAdapter.uninstall({ scope: 'user', home, cwd });
    expect(result.removed.length).toBeGreaterThan(0);
  });

  // C7 — resolve fallback at adapter level
  it('hooks still install when mcp-resolve fails (warning surfaced, no MCP block)', () => {
    vi.spyOn(mcpResolve, 'resolveBrainMcpInvocation').mockReturnValue({
      invocation: null,
      warning: 'forced resolution miss',
    });
    const result = codexAdapter.install({ scope: 'user', home, cwd });
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toMatch(/^hooks\s*=\s*true/m);
    expect(toml).not.toMatch(/\[mcp_servers\.second-brain\]/);
    expect(result.warnings).toContain('forced resolution miss');
  });
});

describe('upsertCodexConfigToml — features migration', () => {
  // C2 — migration of deprecated codex_hooks = true
  it('migrates `codex_hooks = true` → `hooks = true`', () => {
    const input = '[features]\ncodex_hooks = true\nother = false\n';
    const { next, changed } = upsertCodexConfigToml(input, fakeInvocation);
    expect(changed).toBe(true);
    expect(next).toMatch(/^hooks\s*=\s*true/m);
    expect(next).not.toMatch(/codex_hooks/);
    expect(next).toMatch(/other = false/);
  });

  // C2 (continued) — leave codex_hooks = false alone
  it('leaves `codex_hooks = false` untouched (user opt-out)', () => {
    const input = '[features]\ncodex_hooks = false\n';
    const { next } = upsertCodexConfigToml(input, fakeInvocation);
    expect(next).toMatch(/codex_hooks\s*=\s*false/);
  });

  it('adds [features] hooks = true to an empty file', () => {
    const { next, changed } = upsertCodexConfigToml('', fakeInvocation);
    expect(changed).toBe(true);
    expect(next).toMatch(/\[features\]/);
    expect(next).toMatch(/^hooks\s*=\s*true/m);
  });

  it('adds hooks = true into existing [features] block without other flag', () => {
    const initial = '[features]\nother = false\n';
    const { next } = upsertCodexConfigToml(initial, fakeInvocation);
    expect(next).toMatch(/^hooks\s*=\s*true/m);
    expect(next).toMatch(/other = false/);
  });
});

describe('upsertCodexConfigToml — MCP managed region', () => {
  // C3 — helper integration: command + args reflect the invocation passed in
  it('writes managed block reflecting the invocation', () => {
    const { next } = upsertCodexConfigToml('', fakeInvocation);
    expect(next).toContain('# >>> second-brain-mcp managed block');
    expect(next).toContain('# <<< second-brain-mcp managed block');
    expect(next).toMatch(/command = "\/opt\/homebrew\/bin\/node"/);
    expect(next).toMatch(/args = \["\/abs\/path\/to\/packages\/mcp-server\/dist\/stdio\.mjs"\]/);
  });

  // C4 — sentinel state 1 (no-op)
  it('is idempotent over the MCP region (same invocation → no change)', () => {
    const { next: first } = upsertCodexConfigToml('', fakeInvocation);
    const { next: second, changed } = upsertCodexConfigToml(first, fakeInvocation);
    expect(changed).toBe(false);
    expect(second).toBe(first);
  });

  // C5 — sentinel state 2 (commented-out body → respect user intent)
  it('respects user-commented-out managed block (no rewrite, warning emitted)', () => {
    const { next: first } = upsertCodexConfigToml('', fakeInvocation);
    // Comment out lines ONLY between the managed markers (mirrors what a user
    // would do by hand to disable while keeping the markers intact).
    const lines = first.split('\n');
    const beginIdx = lines.findIndex((l) => l.startsWith('# >>> second-brain-mcp'));
    const endIdx = lines.findIndex((l) => l.startsWith('# <<< second-brain-mcp'));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
    for (let i = beginIdx + 1; i < endIdx; i++) {
      const line = lines[i];
      if (line.trim() === '' || line.startsWith('#')) continue;
      lines[i] = '# ' + line;
    }
    const commented = lines.join('\n');
    const { next: second, changed, warning } = upsertCodexConfigToml(commented, fakeInvocation);
    expect(second).toBe(commented);
    expect(changed).toBe(false);
    expect(warning).toMatch(/commented out/);
  });

  // C6 — node-version change rewrites the block
  it('rewrites managed block when invocation differs (node version switch)', () => {
    const { next: first } = upsertCodexConfigToml('', fakeInvocation);
    const { next: second, changed } = upsertCodexConfigToml(first, fakeInvocationB);
    expect(changed).toBe(true);
    expect(second).toMatch(/command = "\/Users\/x\/\.volta\/bin\/node"/);
    expect(second).not.toMatch(/command = "\/opt\/homebrew\/bin\/node"/);
  });

  // Legacy upgrade (state 3): unmanaged `[mcp_servers.second-brain]` → wrap in markers
  it('strips a legacy unmanaged block and replaces with managed region', () => {
    const initial = [
      '[mcp_servers.second-brain]',
      'command = "brain"',
      'args = ["mcp"]',
      '',
      '[tui.x]',
      'y = 1',
    ].join('\n');
    const { next, changed } = upsertCodexConfigToml(initial, fakeInvocation);
    expect(changed).toBe(true);
    expect(next).toContain('# >>> second-brain-mcp managed block');
    expect(next).toMatch(/command = "\/opt\/homebrew\/bin\/node"/);
    // Legacy literal must be gone (the only command= line should be the new one).
    expect(next.match(/command = "brain"/)).toBeNull();
    // Unrelated section preserved.
    expect(next).toMatch(/\[tui\.x\]/);
  });

  // State 5 — invocation null with existing managed region → strip
  it('strips managed region when invocation is null', () => {
    const { next: first } = upsertCodexConfigToml('', fakeInvocation);
    const { next: stripped, changed } = upsertCodexConfigToml(first, null);
    expect(changed).toBe(true);
    expect(stripped).not.toContain('# >>> second-brain-mcp managed block');
    expect(stripped).not.toMatch(/\[mcp_servers\.second-brain\]/);
    expect(stripped).toMatch(/^hooks\s*=\s*true/m);
  });

  it('preserves unrelated mcp_servers blocks', () => {
    const initial = '[mcp_servers.other]\ncommand = "other"\n';
    const { next } = upsertCodexConfigToml(initial, fakeInvocation);
    expect(next).toMatch(/\[mcp_servers\.other\]/);
    expect(next).toMatch(/\[mcp_servers\.second-brain\]/);
  });
});
