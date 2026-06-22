import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBrainMcpInvocation } from '../mcp-resolve.js';

describe('resolveBrainMcpInvocation', () => {
  it('resolves to process.execPath + absolute dist/stdio.mjs in monorepo dev mode', () => {
    const result = resolveBrainMcpInvocation();
    expect(result.warning).toBeUndefined();
    expect(result.invocation).not.toBeNull();
    if (!result.invocation) throw new Error('expected invocation');
    expect(result.invocation.command).toBe(process.execPath);
    expect(result.invocation.args).toHaveLength(1);
    expect(path.isAbsolute(result.invocation.args[0])).toBe(true);
    expect(result.invocation.args[0]).toMatch(/\.mjs$/);
    expect(fs.existsSync(result.invocation.args[0])).toBe(true);
    // Validates that the resolved file is actually @second-brain/mcp-server's stdio entry,
    // regardless of whether resolution goes through the workspace symlink or node_modules root.
    expect(result.invocation.args[0]).toMatch(/mcp-server[/\\]dist[/\\]stdio\.mjs$/);
  });

  it('omits env block when brainDbPath not provided', () => {
    const result = resolveBrainMcpInvocation();
    expect(result.invocation?.env).toBeUndefined();
  });

  it('includes env block when brainDbPath is provided', () => {
    const result = resolveBrainMcpInvocation({ brainDbPath: '/x/personal.db' });
    expect(result.invocation?.env).toEqual({ BRAIN_DB_PATH: '/x/personal.db' });
  });
});
