/**
 * Smoke test for the legacy `installClaudeHooks` / `uninstallClaudeHooks`
 * surface. The full Claude installer behavior is covered in
 * `src/adapters/__tests__/claude.test.ts`; this file just makes sure the
 * back-compat re-export from `install-claude-hooks.ts` keeps working.
 */
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
} from '../install-claude-hooks.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hook-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('installClaudeHooks (legacy alias)', () => {
  it('writes all hook entries to a fresh settings.json (user scope)', () => {
    const result = installClaudeHooks({ scope: 'user', tool: 'claude', homeDir: tmp });
    expect(result.addedHooks.sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
    const hooks = raw.hooks;
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(hooks[event]).toBeTruthy();
      const cmd = hooks[event][0].hooks[0].command;
      // Every brain-hook command starts with the binary name and carries the
      // sentinel comment marker `# brain:v2` for stable dedup.
      expect(cmd.startsWith('brain-hook')).toBe(true);
      expect(cmd).toContain('# brain:v2');
    }
  });

  it('coexists with claude-mem by default (smoke)', () => {
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
    const cmds: string[] = hooks.SessionStart.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
    );
    expect(cmds).toContain('claude-mem session-start');
    expect(cmds.some((c) => c.startsWith('brain-hook session-start'))).toBe(true);
  });

  it('--skip-if-claude-mem skips when claude-mem present', () => {
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

  it('uninstall removes brain hook entries', () => {
    installClaudeHooks({ scope: 'user', tool: 'claude', homeDir: tmp });
    const removed = uninstallClaudeHooks({ scope: 'user', homeDir: tmp });
    expect(removed.removed.length).toBeGreaterThan(0);
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

describe('detectClaudeMem / stripClaudeMem (legacy)', () => {
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
