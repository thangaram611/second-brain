import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { copilotAdapter, upsertSentinelBlock } from '../copilot.js';
import { HOOK_SENTINEL } from '../types.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cwd-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('copilotAdapter — project scope', () => {
  it('writes .github/hooks/second-brain.json with all events', () => {
    const result = copilotAdapter.install({ scope: 'project', home, cwd });
    expect(result.configPath).toBe(path.join(cwd, '.github', 'hooks', 'second-brain.json'));
    const raw = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(raw.hooks.sessionStart[0].command).toContain('--adapter copilot');
    expect(raw.hooks.sessionStart[0].command).toContain(HOOK_SENTINEL);
    expect(raw.hooks.preToolUse[0].command).toContain('--phase pre');
  });

  it('writes copilot-instructions.md sentinel block', () => {
    copilotAdapter.install({ scope: 'project', home, cwd });
    const instructionsPath = path.join(cwd, '.github', 'copilot-instructions.md');
    expect(fs.existsSync(instructionsPath)).toBe(true);
    const content = fs.readFileSync(instructionsPath, 'utf8');
    expect(content).toContain('<!-- begin:second-brain -->');
    expect(content).toContain('<!-- end:second-brain -->');
  });

  it('preserves existing copilot-instructions content outside sentinels', () => {
    const instructionsPath = path.join(cwd, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    fs.writeFileSync(instructionsPath, '# Existing\n\nDo not delete this header.\n');
    copilotAdapter.install({ scope: 'project', home, cwd });
    const content = fs.readFileSync(instructionsPath, 'utf8');
    expect(content).toContain('# Existing');
    expect(content).toContain('Do not delete this header');
    expect(content).toContain('<!-- begin:second-brain -->');
  });

  it('writes mcp-config.json', () => {
    copilotAdapter.install({ scope: 'project', home, cwd });
    const mcpPath = path.join(home, '.copilot', 'mcp-config.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(mcp.mcpServers['second-brain']).toBeDefined();
  });

  it('writes AGENTS.md only when missing', () => {
    copilotAdapter.install({ scope: 'project', home, cwd });
    const agentsPath = path.join(cwd, 'AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);

    // Pre-existing content must not be overwritten on re-install.
    fs.writeFileSync(agentsPath, '# my agents\n');
    copilotAdapter.install({ scope: 'project', home, cwd });
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe('# my agents\n');
  });

  it('is idempotent', () => {
    copilotAdapter.install({ scope: 'project', home, cwd });
    const second = copilotAdapter.install({ scope: 'project', home, cwd });
    expect(second.addedEvents).toEqual([]);
  });
});

describe('copilotAdapter — user scope', () => {
  it('skips hooks but installs MCP and emits a warning', () => {
    const result = copilotAdapter.install({ scope: 'user', home, cwd });
    expect(result.skipped).toMatch(/user scope/);
    expect(result.warnings.some((w) => /undocumented/.test(w))).toBe(true);
    const mcpPath = path.join(home, '.copilot', 'mcp-config.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
  });
});

describe('upsertSentinelBlock', () => {
  it('inserts a fresh block in empty content', () => {
    const out = upsertSentinelBlock('', 'hello');
    expect(out).toContain('<!-- begin:second-brain -->');
    expect(out).toContain('hello');
  });

  it('appends to existing content', () => {
    const out = upsertSentinelBlock('# Title\n\ncontent', 'block');
    expect(out).toContain('# Title');
    expect(out).toContain('block');
  });

  it('replaces an existing sentinel block', () => {
    const initial = `# Header\n\n<!-- begin:second-brain -->\nold\n<!-- end:second-brain -->\n`;
    const out = upsertSentinelBlock(initial, 'fresh');
    expect(out).not.toContain('old');
    expect(out).toContain('fresh');
    expect(out).toContain('# Header');
  });
});
