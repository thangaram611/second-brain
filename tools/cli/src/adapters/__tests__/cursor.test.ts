import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cursorAdapter } from '../cursor.js';
import { HOOK_SENTINEL } from '../types.js';

let tmp: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cwd-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
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

    // MCP config
    const mcpPath = path.join(cwd, '.cursor', 'mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(mcp.mcpServers['second-brain']).toBeDefined();
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

  it('uninstall removes only sentinel entries', () => {
    cursorAdapter.install({ scope: 'project', home: tmp, cwd });
    const result = cursorAdapter.uninstall({ scope: 'project', home: tmp, cwd });
    expect(result.removed.length).toBeGreaterThan(0);
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    // After uninstall, hooks file should have an empty `hooks` map.
    expect(Object.keys(raw.hooks ?? {})).toEqual([]);
  });
});
