import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { claudeAdapter } from '../claude.js';
import { HOOK_SENTINEL } from '../types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('claudeAdapter — install', () => {
  it('writes all 6 hook events at user scope and includes sentinel marker', () => {
    const result = claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    expect(result.configPath).toBe(path.join(tmp, '.claude', 'settings.json'));
    expect(result.addedEvents).toContain('SessionStart');
    expect(result.addedEvents).toContain('PreToolUse');

    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    const cmd = raw.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain(HOOK_SENTINEL);
    expect(cmd).toContain('--adapter claude');
  });

  it('PreToolUse uses the heavy-tool matcher', () => {
    const result = claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(raw.hooks.PreToolUse[0].matcher).toBe('^(Read|Edit|Write|MultiEdit|Bash|Grep|Glob)$');
  });

  it('is idempotent — second install adds no new events', () => {
    claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    const second = claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    expect(second.addedEvents).toEqual([]);
  });

  it('sentinel-based dedup replaces stale our-entries on re-install', () => {
    // Pre-seed with an outdated path (different binary location, same sentinel)
    const settingsPath = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: `/old/path/brain-hook session-start --adapter claude ${HOOK_SENTINEL}` }] }],
        },
      }),
    );
    const result = claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    const cmds = raw.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(cmds.some((c: string) => c.startsWith('/old/path/'))).toBe(false);
    expect(cmds.some((c: string) => c.startsWith('brain-hook'))).toBe(true);
  });

  it('coexists with claude-mem by default', () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'claude-mem session-start' }] }],
        },
      }),
    );
    const result = claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    expect(result.warnings.some((w) => /claude-mem/.test(w))).toBe(true);
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    const cmds = raw.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain('claude-mem session-start');
    expect(cmds.some((c: string) => /^brain-hook session-start/.test(c))).toBe(true);
  });

  it('uninstall removes all sentinel-tagged entries', () => {
    claudeAdapter.install({ scope: 'user', home: tmp, cwd: tmp });
    const result = claudeAdapter.uninstall({ scope: 'user', home: tmp, cwd: tmp });
    expect(result.removed.length).toBeGreaterThan(0);
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(raw.hooks).toEqual({});
  });
});
