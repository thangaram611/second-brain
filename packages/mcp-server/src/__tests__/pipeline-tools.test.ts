import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  await client.close();
  await mcp.close();
  brain.close();
});

function textFromCall(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const obj = result as Record<string, unknown>;
  const content = obj.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).text === 'string'
        ? String((b as Record<string, unknown>).text)
        : '',
    )
    .join('\n');
}

describe('Pipeline MCP tools', () => {
  it('lists the new pipeline tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('reindex');
    expect(names).toContain('export_graph');
    expect(names).toContain('import_graph');
    expect(names).toContain('rebuild_embeddings');
    expect(names).toContain('query_graph');
  });

  it('reindex rebuilds the FTS index without error', async () => {
    brain.entities.create({
      type: 'concept',
      name: 'Reindex me',
      source: { type: 'manual' },
    });
    const result = await client.callTool({ name: 'reindex', arguments: {} });
    const text = textFromCall(result);
    expect(text).toContain('rebuilt');

    // Subsequent search must still work.
    const search = await client.callTool({
      name: 'search_brain',
      arguments: { query: 'reindex' },
    });
    expect(textFromCall(search).toLowerCase()).toContain('reindex');
  });

  it('export_graph emits valid JSON containing all entities', async () => {
    brain.entities.create({ type: 'concept', name: 'Alpha', source: { type: 'manual' } });
    brain.entities.create({ type: 'tool', name: 'Beta', source: { type: 'manual' } });

    const result = await client.callTool({
      name: 'export_graph',
      arguments: { format: 'json' },
    });
    const payload = JSON.parse(textFromCall(result));
    expect(payload.entities).toHaveLength(2);
    const names = payload.entities.map((e: { name: string }) => e.name);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('export_graph DOT format produces a parseable graph header', async () => {
    brain.entities.create({ type: 'concept', name: 'Node1', source: { type: 'manual' } });
    const result = await client.callTool({
      name: 'export_graph',
      arguments: { format: 'dot' },
    });
    const text = textFromCall(result);
    expect(text).toMatch(/^\s*(?:strict\s+)?digraph\b/);
    expect(text).toContain('Node1');
  });

  it('import_graph round-trips a JSON export', async () => {
    brain.entities.create({
      type: 'fact',
      name: 'F1',
      observations: ['o1', 'o2'],
      source: { type: 'manual' },
    });
    brain.entities.create({
      type: 'fact',
      name: 'F2',
      source: { type: 'manual' },
    });
    const exported = textFromCall(
      await client.callTool({ name: 'export_graph', arguments: { format: 'json' } }),
    );

    // Wipe the brain by deleting all entities.
    for (const e of brain.entities.list()) {
      brain.entities.delete(e.id);
    }
    expect(brain.entities.count()).toBe(0);

    const imp = await client.callTool({
      name: 'import_graph',
      arguments: { content: exported, format: 'json', strategy: 'upsert' },
    });
    expect(textFromCall(imp)).toContain('Imported 2 entities');
    expect(brain.entities.count()).toBe(2);
  });

  it('rebuild_embeddings reports a clear error when vector search not enabled and no dimensions arg', async () => {
    const result = await client.callTool({
      name: 'rebuild_embeddings',
      arguments: {},
    });
    const text = textFromCall(result);
    expect(text).toContain('dimensions');
  });

  it('query_graph falls back to fulltext when no LLM is reachable', async () => {
    brain.entities.create({
      type: 'concept',
      name: 'GraphTraversal',
      observations: ['BFS through entities'],
      source: { type: 'manual' },
    });

    // No BRAIN_LLM_PROVIDER → resolveLLMConfig returns ollama default; the
    // actual generateObject() call will fail (no Ollama running in test),
    // which we silently swallow and fall back to plain FTS.
    const result = await client.callTool({
      name: 'query_graph',
      arguments: { question: 'GraphTraversal' },
    });
    expect(textFromCall(result)).toContain('GraphTraversal');
  });
});
