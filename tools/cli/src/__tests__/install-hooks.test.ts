import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  installClaudeHooks,
  uninstallClaudeHooks,
  detectClaudeMem,
  stripClaudeMem,
  CLAUDE_HOOK_EVENTS,
} from '../install-hooks.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hook-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('installClaudeHooks', () => {
  it('writes all hook entries to a fresh settings.json (user scope)', () => {
    const result = installClaudeHooks({ scope: 'user', tool: 'claude', homeDir: tmp });
    expect(result.addedHooks.sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
    const hooks = raw.hooks;
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(hooks[event]).toBeTruthy();
      const cmd = hooks[event][0].hooks[0].command;
      expect(cmd.startsWith('brain-hook')).toBe(true);
    }
    // PreToolUse should carry a matcher.
    expect(hooks.PreToolUse[0].matcher).toBe('.*');
    // UserPromptSubmit should NOT carry a matcher per Claude Code spec.
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined();
  });

  it('coexists with an existing claude-mem hook by default', () => {
    const dir = path.join(tmp, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'claude-mem session-start' }] }],
        },
      }),
    );

    const result = installClaudeHooks({ scope: 'user', tool: 'claude', homeDir: tmp });
    expect(result.coexistedWithClaudeMem).toBe(true);
    const hooks = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')).hooks;
    const cmds = hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain('claude-mem session-start');
    expect(cmds).toContain('brain-hook session-start');
  });

  it('with --exclusive backs up and strips claude-mem hooks', () => {
    const dir = path.join(tmp, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'claude-mem session-start' }] }],
        },
      }),
    );

    const result = installClaudeHooks({
      scope: 'user',
      tool: 'claude',
      homeDir: tmp,
      exclusive: true,
    });
    expect(result.backupPath).toBeTruthy();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    const hooks = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')).hooks;
    const cmds = hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).not.toContain('claude-mem session-start');
    expect(cmds).toContain('brain-hook session-start');
  });

  it('with --skip-if-claude-mem skips install when claude-mem present', () => {
    const dir = path.join(tmp, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'npx claude-mem hook' }] }],
        },
      }),
    );

    const result = installClaudeHooks({
      scope: 'user',
      tool: 'claude',
      homeDir: tmp,
      skipIfClaudeMem: true,
    });
    expect(result.skipped).toMatch(/claude-mem/);
    expect(result.addedHooks).toHaveLength(0);
  });

  it('uninstall restores prior state without touching claude-mem', () => {
    const dir = path.join(tmp, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'claude-mem session-start' }] }],
        },
      }),
    );

    installClaudeHooks({ scope: 'user', tool: 'claude', homeDir: tmp });
    const removed = uninstallClaudeHooks({ scope: 'user', homeDir: tmp });
    expect(removed.removed.length).toBeGreaterThan(0);
    const hooks = JSON.parse(fs.readFileSync(removed.settingsPath, 'utf8')).hooks ?? {};
    const cmds = (hooks.SessionStart ?? []).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain('claude-mem session-start');
    expect(cmds).not.toContain('brain-hook session-start');
  });

  it('project scope writes to <cwd>/.claude/settings.json', () => {
    const result = installClaudeHooks({
      scope: 'project',
      tool: 'claude',
      homeDir: tmp,
      cwd: tmp,
    });
    expect(result.settingsPath).toBe(path.join(tmp, '.claude', 'settings.json'));
    expect(fs.existsSync(result.settingsPath)).toBe(true);
  });
});

describe('detectClaudeMem / stripClaudeMem', () => {
  it('recognizes both bare and npx command forms', () => {
    expect(detectClaudeMem({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'claude-mem hook' }] }] } })).toBe(true);
    expect(detectClaudeMem({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx @claude-mem/cli' }] }] } })).toBe(true);
    expect(detectClaudeMem({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'unrelated' }] }] } })).toBe(false);
  });

  it('strips entries while preserving unrelated hooks', () => {
    const before = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command' as const, command: 'claude-mem x' }] },
          { hooks: [{ type: 'command' as const, command: 'other' }] },
        ],
      },
    };
    const after = stripClaudeMem(before);
    const cmds = after.hooks!.SessionStart!.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toEqual(['other']);
  });
});
