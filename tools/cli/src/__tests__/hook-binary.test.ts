import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import { buildRequestBody, buildEnvelope, runHook } from '../hook-binary.js';

describe('buildRequestBody', () => {
  it('session-start maps tool+cwd', () => {
    const body = buildRequestBody('session-start', undefined, {
      session_id: 'abc',
      cwd: '/repo',
    });
    expect(body.sessionId).toBe('abc');
    expect(body.cwd).toBe('/repo');
    expect(body.tool).toBe('claude');
  });

  it('uses adapter as the tool name', () => {
    const body = buildRequestBody('session-start', undefined, { session_id: 'a' }, 'cursor');
    expect(body.tool).toBe('cursor');
  });

  it('forwards cwd on prompt-submit (PR2 fix)', () => {
    const body = buildRequestBody('prompt-submit', undefined, {
      session_id: 'a',
      prompt: 'do',
      cwd: '/repo',
    });
    expect(body.prompt).toBe('do');
    expect(body.cwd).toBe('/repo');
  });

  it('forwards cwd on tool-use (PR2 fix)', () => {
    const body = buildRequestBody('tool-use', 'pre', {
      session_id: 'a',
      tool_name: 'Read',
      cwd: '/repo',
      tool_input: { file_path: '/repo/src/a.ts' },
    });
    expect(body.cwd).toBe('/repo');
    expect(body.phase).toBe('pre');
  });

  it('tool-use post-inject is normalized to post on the wire', () => {
    const body = buildRequestBody('tool-use', 'post-inject', {
      session_id: 'a',
      tool_name: 'Read',
    });
    expect(body.phase).toBe('post');
  });

  it('tool-use extracts file paths heuristically', () => {
    const body = buildRequestBody('tool-use', 'post', {
      sessionId: 'x',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/a.ts' },
      tool_response: { oldPath: '/repo/src/b.ts' },
    });
    expect(body.toolName).toBe('Edit');
    expect(body.phase).toBe('post');
    expect(body.filePaths).toEqual(expect.arrayContaining(['/repo/src/a.ts', '/repo/src/b.ts']));
  });
});

describe('buildEnvelope — per-adapter', () => {
  it('Claude PreToolUse includes hookEventName=PreToolUse and permissionDecision', () => {
    const env = buildEnvelope({
      adapter: 'claude',
      hook: 'tool-use',
      phase: 'pre',
      contextBlock: '# ctx',
    });
    expect(env).toContain('"hookEventName":"PreToolUse"');
    expect(env).toContain('"permissionDecision":"allow"');
    expect(env).toContain('# ctx');
  });

  it('Claude UserPromptSubmit includes hookEventName=UserPromptSubmit', () => {
    const env = buildEnvelope({
      adapter: 'claude',
      hook: 'prompt-submit',
      contextBlock: '# ctx',
    });
    expect(env).toContain('"hookEventName":"UserPromptSubmit"');
  });

  it('Claude SessionStart envelope', () => {
    const env = buildEnvelope({ adapter: 'claude', hook: 'session-start', contextBlock: 'X' });
    expect(env).toContain('"hookEventName":"SessionStart"');
  });

  it('Codex uses the same camelCase envelope as Claude', () => {
    const env = buildEnvelope({
      adapter: 'codex',
      hook: 'tool-use',
      phase: 'pre',
      contextBlock: 'Y',
    });
    expect(env).toContain('"hookEventName":"PreToolUse"');
  });

  it('Cursor sessionStart uses snake_case additional_context, no hookEventName', () => {
    const env = buildEnvelope({ adapter: 'cursor', hook: 'session-start', contextBlock: 'Z' });
    expect(env).toContain('additional_context');
    expect(env).not.toContain('hookEventName');
  });

  it('Cursor postToolUse is suppressed unless BRAIN_CURSOR_POSTTOOL_INJECT=1', () => {
    delete process.env.BRAIN_CURSOR_POSTTOOL_INJECT;
    const off = buildEnvelope({ adapter: 'cursor', hook: 'tool-use', phase: 'post-inject', contextBlock: 'X' });
    expect(off).toBe('');
    process.env.BRAIN_CURSOR_POSTTOOL_INJECT = '1';
    const on = buildEnvelope({ adapter: 'cursor', hook: 'tool-use', phase: 'post-inject', contextBlock: 'X' });
    expect(on).toContain('additional_context');
    delete process.env.BRAIN_CURSOR_POSTTOOL_INJECT;
  });

  it('Copilot emits no envelope (observe-only)', () => {
    const env = buildEnvelope({ adapter: 'copilot', hook: 'session-start', contextBlock: 'X' });
    expect(env).toBe('');
  });

  it('empty contextBlock returns empty string', () => {
    const env = buildEnvelope({ adapter: 'claude', hook: 'session-start', contextBlock: '' });
    expect(env).toBe('');
  });
});

describe('runHook', () => {
  beforeEach(() => {
    delete process.env.BRAIN_HOOK_DISABLE;
  });
  afterEach(() => {
    delete process.env.BRAIN_HOOK_DISABLE;
  });

  it('returns 0 even when the server is unreachable', async () => {
    const code = await runHook(
      ['node', 'brain-hook', 'session-start'],
      JSON.stringify({ session_id: 'zz', cwd: '/x' }),
      {
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    );
    expect(code).toBe(0);
  });

  it('SessionStart writes hookSpecificOutput envelope (Claude default)', async () => {
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runHook(
        ['node', 'brain-hook', 'session-start'],
        JSON.stringify({ session_id: 'k' }),
        {
          fetchImpl: async () =>
            new Response(JSON.stringify({ contextBlock: '# Prior work\n- foo' }), {
              status: 200,
            }),
        },
      );
    } finally {
      process.stdout.write = origWrite;
    }

    const combined = stdoutChunks.join('');
    expect(combined).toContain('"hookEventName":"SessionStart"');
    expect(combined).toContain('# Prior work');
  });

  it('PreToolUse envelope (Claude) — adapter flag + phase pre', async () => {
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runHook(
        ['node', 'brain-hook', 'tool-use', '--phase', 'pre', '--adapter', 'claude'],
        JSON.stringify({ session_id: 'k', tool_name: 'Read', cwd: '/repo' }),
        {
          fetchImpl: async () =>
            new Response(JSON.stringify({ contextBlock: 'inject me' }), { status: 201 }),
        },
      );
    } finally {
      process.stdout.write = origWrite;
    }

    const combined = stdoutChunks.join('');
    expect(combined).toContain('"hookEventName":"PreToolUse"');
    expect(combined).toContain('"permissionDecision":"allow"');
    expect(combined).toContain('inject me');
  });

  it('redacts secrets from tool_input before POST', async () => {
    let observedBody = '';
    await runHook(
      ['node', 'brain-hook', 'tool-use', '--phase', 'post', '--adapter', 'claude'],
      JSON.stringify({
        session_id: 'k',
        tool_name: 'Bash',
        tool_input: { command: 'AWS_SECRET_ACCESS_KEY=hunter2 aws s3 ls' },
      }),
      {
        fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
          observedBody = typeof init?.body === 'string' ? init.body : '';
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(observedBody).not.toContain('hunter2');
    expect(observedBody).toContain('[REDACTED]');
  });

  it('forwards cwd on tool-use POST', async () => {
    let observedBody = '';
    await runHook(
      ['node', 'brain-hook', 'tool-use', '--phase', 'pre', '--adapter', 'claude'],
      JSON.stringify({
        session_id: 'k',
        tool_name: 'Read',
        cwd: '/repo/x',
        tool_input: { file_path: '/repo/x/auth.ts' },
      }),
      {
        fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
          observedBody = typeof init?.body === 'string' ? init.body : '';
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(observedBody).toContain('"cwd":"/repo/x"');
  });

  it('honors BRAIN_HOOK_DISABLE=1 — never POSTs', async () => {
    process.env.BRAIN_HOOK_DISABLE = '1';
    let calls = 0;
    const code = await runHook(
      ['node', 'brain-hook', 'session-start'],
      JSON.stringify({ session_id: 'k' }),
      {
        fetchImpl: async () => {
          calls++;
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(0);
  });

  it('short-circuits on Read of .env files — no POST, no envelope', async () => {
    let calls = 0;
    const code = await runHook(
      ['node', 'brain-hook', 'tool-use', '--phase', 'pre', '--adapter', 'claude'],
      JSON.stringify({
        session_id: 'k',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/.env.production' },
      }),
      {
        fetchImpl: async () => {
          calls++;
          return new Response(JSON.stringify({ contextBlock: 'shouldnotappear' }), { status: 200 });
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(0);
  });

  it('Cursor adapter: sessionStart emits snake_case envelope', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runHook(
        ['node', 'brain-hook', 'session-start', '--adapter', 'cursor'],
        JSON.stringify({ session_id: 'k' }),
        {
          fetchImpl: async () =>
            new Response(JSON.stringify({ contextBlock: 'wip stuff' }), { status: 200 }),
        },
      );
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join('');
    expect(out).toContain('additional_context');
    expect(out).not.toContain('hookEventName');
  });
});
