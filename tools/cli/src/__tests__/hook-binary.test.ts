import { describe, it, expect } from 'vitest';
import { buildRequestBody, runHook } from '../hook-binary.js';

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

  it('prompt-submit preserves prompt string', () => {
    const body = buildRequestBody('prompt-submit', undefined, {
      session_id: 'abc',
      prompt: 'do the thing',
    });
    expect(body.prompt).toBe('do the thing');
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

describe('runHook', () => {
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

  it('SessionStart writes hookSpecificOutput when server returns contextBlock', async () => {
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
});
