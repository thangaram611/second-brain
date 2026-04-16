import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brain } from '@second-brain/core';

let mcp: McpServer;
let brain: Brain;
let client: Client;

beforeEach(async () => {
  const result = createMcpServer({ dbPath: ':memory:', wal: false });
  mcp = result.mcp;
  brain = result.brain;

  client = new Client({ name: 'test-client', version: '1.0.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  await mcp.close();
  brain.close();
});

function text(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe('get_ownership', () => {
  it('returns formatted ownership text for a valid response', async () => {
    const mockScores = [
      {
        actor: 'alice',
        score: 0.72,
        signals: {
          commits: 15,
          recencyWeightedBlameLines: 320,
          reviews: 8,
          testAuthorship: 3,
          codeownerMatch: true,
        },
      },
      {
        actor: 'bob',
        score: 0.28,
        signals: {
          commits: 5,
          recencyWeightedBlameLines: 80,
          reviews: 2,
          testAuthorship: 0,
          codeownerMatch: false,
        },
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockScores),
      }),
    );

    const result = await client.callTool({
      name: 'get_ownership',
      arguments: { path: 'src/core/engine.ts' },
    });

    const output = text(result);
    expect(output).toContain('Ownership for src/core/engine.ts:');
    expect(output).toContain('alice (score: 72.0%)');
    expect(output).toContain('bob (score: 28.0%)');
    expect(output).toContain('commits: 15');
    expect(output).toContain('codeowner: true');
  });

  it('returns "no ownership data" for empty response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }),
    );

    const result = await client.callTool({
      name: 'get_ownership',
      arguments: { path: 'unknown/file.ts' },
    });

    expect(text(result)).toBe('No ownership data found for unknown/file.ts');
  });

  it('handles server error gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }),
    );

    const result = await client.callTool({
      name: 'get_ownership',
      arguments: { path: 'src/main.ts' },
    });

    expect(text(result)).toBe('Ownership query failed (500): Internal Server Error');
  });

  it('passes path and limit params correctly in URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal('fetch', fetchMock);

    await client.callTool({
      name: 'get_ownership',
      arguments: { path: 'packages/core/index.ts', limit: 5 },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/api/query/ownership');
    expect(calledUrl.searchParams.get('path')).toBe('packages/core/index.ts');
    expect(calledUrl.searchParams.get('limit')).toBe('5');
  });
});
