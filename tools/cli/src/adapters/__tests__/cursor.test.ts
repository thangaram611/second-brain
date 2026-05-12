import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cursorAdapter } from '../cursor.js';
import { HOOK_SENTINEL } from '../types.js';
import * as mcpResolve from '../mcp-resolve.js';

let tmp: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cwd-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cursorAdapter — install', () => {
  it('writes hooks.json + .mdc rules + mcp.json at project scope', () => {
    const result = cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    expect(result.configPath).toBe(path.join(cwd, '.cursor', 'hooks.json'));
    expect(fs.existsSync(result.configPath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(raw.hooks.sessionStart[0].command).toContain('--adapter cursor');
    expect(raw.hooks.sessionStart[0].command).toContain(HOOK_SENTINEL);

    // Rules file uses .mdc extension
    const rulesPath = path.join(cwd, '.cursor', 'rules', 'second-brain-context.mdc');
    expect(fs.existsSync(rulesPath)).toBe(true);
    expect(result.auxFiles).toContain(rulesPath);

    // C8 — MCP config uses absolute command + absolute stdio.mjs path
    const mcpPath = path.join(cwd, '.cursor', 'mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    const entry = mcp.mcpServers['second-brain'];
    expect(entry).toBeDefined();
    expect(entry.command).toBe(process.execPath);
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args[0]).toMatch(/\.mjs$/);
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(fs.existsSync(entry.args[0])).toBe(true);
  });

  it('is idempotent — re-running adds no events', () => {
    cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    const second = cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    expect(second.addedEvents).toEqual([]);
  });

  it('preserves unrelated user mcp servers', () => {
    const mcpPath = path.join(cwd, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
    cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers['second-brain']).toBeDefined();
  });

  // C9 — resolve fallback: hooks still install, MCP block skipped + warning surfaced
  it('hooks still install when mcp-resolve fails (no MCP entry, warning surfaced)', () => {
    vi.spyOn(mcpResolve, 'resolveBrainMcpInvocation').mockReturnValue({
      invocation: null,
      warning: 'forced resolution miss (cursor)',
    });
    const result = cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    expect(fs.existsSync(result.configPath)).toBe(true);
    expect(result.warnings).toContain('forced resolution miss (cursor)');
    const mcpPath = path.join(cwd, '.cursor', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(mcp.mcpServers?.['second-brain']).toBeUndefined();
    }
  });

  it('uninstall removes only sentinel entries', () => {
    cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    const result = cursorAdapter.uninstall({ scope: 'project', home: tmp, cwd });
    expect(result.removed.length).toBeGreaterThan(0);
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    // After uninstall, hooks file should have an empty `hooks` map.
    expect(Object.keys(raw.hooks ?? {})).toEqual([]);
  });
});
