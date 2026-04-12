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

describe('MCP Server — Read Tools', () => {
  it('lists available tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();

    expect(names).toContain('search_brain');
    expect(names).toContain('get_entity');
    expect(names).toContain('get_neighbors');
    expect(names).toContain('search_decisions');
    expect(names).toContain('search_patterns');
    expect(names).toContain('get_graph_stats');
    expect(names).toContain('add_entity');
    expect(names).toContain('add_relation');
    expect(names).toContain('add_observation');
    expect(names).toContain('record_decision');
    expect(names).toContain('record_pattern');
    expect(names).toContain('record_fact');
    expect(names).toContain('update_entity');
    expect(names).toContain('merge_entities');
  });

  it('search_brain returns results', async () => {
    brain.entities.create({
      type: 'concept',
      name: 'CRDT',
      observations: ['Conflict-free Replicated Data Types'],
      source: { type: 'manual' },
    });

    const result = await client.callTool({ name: 'search_brain', arguments: { query: 'CRDT' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('CRDT');
    expect(text).toContain('Found 1 result');
  });

  it('search_brain returns empty for no match', async () => {
    const result = await client.callTool({ name: 'search_brain', arguments: { query: 'nonexistent' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe('No results found.');
  });

  it('search_brain filters by type', async () => {
    brain.entities.create({ type: 'concept', name: 'CRDT', source: { type: 'manual' } });
    brain.entities.create({ type: 'decision', name: 'Use CRDT for sync', source: { type: 'manual' } });

    const result = await client.callTool({
      name: 'search_brain',
      arguments: { query: 'CRDT', types: ['decision'] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('decision');
    expect(text).toContain('Found 1 result');
  });

  it('get_entity returns entity details', async () => {
    const entity = brain.entities.create({
      type: 'concept',
      name: 'GraphQL',
      observations: ['Query language for APIs', 'Schema-first design'],
      tags: ['api', 'web'],
      source: { type: 'manual' },
    });

    const result = await client.callTool({ name: 'get_entity', arguments: { id: entity.id } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('GraphQL');
    expect(text).toContain('Query language for APIs');
    expect(text).toContain('api, web');
  });

  it('get_entity returns error for unknown id', async () => {
    const result = await client.callTool({ name: 'get_entity', arguments: { id: 'nonexistent' } });
    expect(result.isError).toBe(true);
  });

  it('get_entity shows relations', async () => {
    const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
    const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
    brain.relations.create({
      type: 'depends_on',
      sourceId: a.id,
      targetId: b.id,
      source: { type: 'manual' },
    });

    const result = await client.callTool({ name: 'get_entity', arguments: { id: a.id } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Outbound Relations');
    expect(text).toContain('depends_on');
    expect(text).toContain('B');
  });

  it('get_neighbors returns connected entities', async () => {
    const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
    const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
    brain.relations.create({
      type: 'depends_on',
      sourceId: a.id,
      targetId: b.id,
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'get_neighbors',
      arguments: { entityId: a.id },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('B');
    expect(text).toContain('depends_on');
  });

  it('get_neighbors returns error for unknown entity', async () => {
    const result = await client.callTool({
      name: 'get_neighbors',
      arguments: { entityId: 'nonexistent' },
    });
    expect(result.isError).toBe(true);
  });

  it('search_decisions filters to decisions', async () => {
    brain.entities.create({
      type: 'decision',
      name: 'Use SQLite for storage',
      observations: ['Local-first requires embedded database'],
      source: { type: 'manual' },
    });
    brain.entities.create({
      type: 'concept',
      name: 'SQLite',
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'search_decisions',
      arguments: { query: 'SQLite' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('decision');
    expect(text).toContain('Found 1');
  });

  it('get_graph_stats returns statistics', async () => {
    brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
    brain.entities.create({ type: 'decision', name: 'B', source: { type: 'manual' } });

    const result = await client.callTool({
      name: 'get_graph_stats',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Entities: 2');
    expect(text).toContain('concept: 1');
    expect(text).toContain('decision: 1');
  });
});

describe('MCP Server — Write Tools', () => {
  it('add_entity creates an entity', async () => {
    const result = await client.callTool({
      name: 'add_entity',
      arguments: {
        type: 'concept',
        name: 'Event Sourcing',
        observations: ['Store all changes as events'],
        tags: ['architecture'],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Created concept');
    expect(text).toContain('Event Sourcing');
    expect(brain.entities.count()).toBe(1);
  });

  it('add_relation creates a relation', async () => {
    const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
    const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });

    const result = await client.callTool({
      name: 'add_relation',
      arguments: {
        type: 'depends_on',
        sourceId: a.id,
        targetId: b.id,
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('depends_on');
    expect(text).toContain('A');
    expect(text).toContain('B');
    expect(brain.relations.count()).toBe(1);
  });

  it('add_relation validates entities exist', async () => {
    const result = await client.callTool({
      name: 'add_relation',
      arguments: {
        type: 'depends_on',
        sourceId: 'nonexistent',
        targetId: 'also-nonexistent',
      },
    });
    expect(result.isError).toBe(true);
  });

  it('add_observation appends to entity', async () => {
    const entity = brain.entities.create({
      type: 'concept',
      name: 'TypeScript',
      observations: ['Typed JS'],
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'add_observation',
      arguments: { entityId: entity.id, observation: 'Supports generics' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('2 observation');

    const updated = brain.entities.get(entity.id);
    expect(updated!.observations).toContain('Supports generics');
  });

  it('record_decision creates decision entity', async () => {
    const result = await client.callTool({
      name: 'record_decision',
      arguments: {
        decision: 'Use SQLite over Postgres for local-first',
        context: 'Need embedded database for offline support',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Decision recorded');

    const decisions = brain.entities.findByType('decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].observations).toContain('Use SQLite over Postgres for local-first');
    expect(decisions[0].observations).toContain('Context: Need embedded database for offline support');
  });

  it('record_decision links to related entities', async () => {
    const concept = brain.entities.create({
      type: 'concept',
      name: 'SQLite',
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'record_decision',
      arguments: {
        decision: 'Use SQLite',
        relatedEntityIds: [concept.id],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('SQLite');
    expect(brain.relations.count()).toBe(1);
  });

  it('record_pattern creates pattern entity', async () => {
    const result = await client.callTool({
      name: 'record_pattern',
      arguments: {
        name: 'Repository pattern',
        observations: ['Abstracts data access behind interface'],
        tags: ['architecture'],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Pattern recorded');

    const patterns = brain.entities.findByType('pattern');
    expect(patterns).toHaveLength(1);
  });

  it('record_fact creates fact entity', async () => {
    const result = await client.callTool({
      name: 'record_fact',
      arguments: {
        name: 'API rate limit',
        observations: ['GitHub API allows 5000 requests/hour'],
        sourceRef: 'https://docs.github.com/en/rest/rate-limit',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Fact recorded');

    const facts = brain.entities.findByType('fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].source.ref).toBe('https://docs.github.com/en/rest/rate-limit');
  });

  it('update_entity modifies fields', async () => {
    const entity = brain.entities.create({
      type: 'concept',
      name: 'REST',
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'update_entity',
      arguments: { id: entity.id, name: 'REST API', confidence: 0.9 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('REST API');

    const updated = brain.entities.get(entity.id);
    expect(updated!.name).toBe('REST API');
    expect(updated!.confidence).toBe(0.9);
  });

  it('update_entity returns error for unknown id', async () => {
    const result = await client.callTool({
      name: 'update_entity',
      arguments: { id: 'nonexistent', name: 'x' },
    });
    expect(result.isError).toBe(true);
  });

  it('merge_entities combines two entities', async () => {
    const primary = brain.entities.create({
      type: 'concept',
      name: 'CRDT',
      observations: ['Conflict-free data types'],
      tags: ['distributed'],
      source: { type: 'manual' },
    });
    const secondary = brain.entities.create({
      type: 'concept',
      name: 'CRDTs',
      observations: ['Used in collaborative editing'],
      tags: ['sync'],
      source: { type: 'manual' },
    });

    const other = brain.entities.create({ type: 'concept', name: 'Yjs', source: { type: 'manual' } });
    brain.relations.create({
      type: 'implements',
      sourceId: other.id,
      targetId: secondary.id,
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'merge_entities',
      arguments: { primaryId: primary.id, secondaryId: secondary.id },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Merged');

    // Secondary should be deleted
    expect(brain.entities.get(secondary.id)).toBeNull();

    // Primary should have merged data
    const merged = brain.entities.get(primary.id)!;
    expect(merged.observations).toContain('Conflict-free data types');
    expect(merged.observations).toContain('Used in collaborative editing');
    expect(merged.tags).toContain('distributed');
    expect(merged.tags).toContain('sync');

    // Relation should be re-pointed to primary
    const inbound = brain.relations.getInbound(primary.id);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].sourceId).toBe(other.id);
  });

  it('traverse_graph finds paths between entities', async () => {
    const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
    const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
    const c = brain.entities.create({ type: 'concept', name: 'C', source: { type: 'manual' } });
    brain.relations.create({ type: 'depends_on', sourceId: a.id, targetId: b.id, source: { type: 'manual' } });
    brain.relations.create({ type: 'depends_on', sourceId: b.id, targetId: c.id, source: { type: 'manual' } });

    const result = await client.callTool({
      name: 'traverse_graph',
      arguments: { fromId: a.id, toId: c.id },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('1 path');
    expect(text).toContain('A');
    expect(text).toContain('C');
  });

  it('traverse_graph returns error for unknown entity', async () => {
    const result = await client.callTool({
      name: 'traverse_graph',
      arguments: { fromId: 'nonexistent', toId: 'also-nonexistent' },
    });
    expect(result.isError).toBe(true);
  });

  it('invalidate sets confidence to 0', async () => {
    const entity = brain.entities.create({
      type: 'fact',
      name: 'Old fact',
      source: { type: 'manual' },
    });

    const result = await client.callTool({
      name: 'invalidate',
      arguments: { entityId: entity.id, reason: 'Outdated information' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Invalidated');

    const updated = brain.entities.get(entity.id)!;
    expect(updated.confidence).toBe(0);
    expect(updated.observations).toContain('Invalidated: Outdated information');
  });

  it('invalidate with replacement creates supersedes relation', async () => {
    const old = brain.entities.create({ type: 'fact', name: 'Old', source: { type: 'manual' } });
    const replacement = brain.entities.create({ type: 'fact', name: 'New', source: { type: 'manual' } });

    const result = await client.callTool({
      name: 'invalidate',
      arguments: { entityId: old.id, replacementId: replacement.id },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Superseded by');

    const rels = brain.relations.getOutbound(replacement.id, 'supersedes');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(old.id);
  });
});

describe('MCP Server — Resources', () => {
  it('lists resource templates', async () => {
    const result = await client.listResourceTemplates();
    const uriTemplates = result.resourceTemplates.map((r) => r.uriTemplate);
    expect(uriTemplates).toContain('brain://entities/{id}');
    expect(uriTemplates).toContain('brain://entities/type/{type}');
    expect(uriTemplates).toContain('brain://search/{query}');
  });

  it('lists static resources', async () => {
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain('brain://graph/stats');
  });

  it('reads graph stats resource', async () => {
    brain.entities.create({ type: 'concept', name: 'Test', source: { type: 'manual' } });

    const result = await client.readResource({ uri: 'brain://graph/stats' });
    const content = result.contents[0];
    const stats = JSON.parse((content as { text: string }).text);
    expect(stats.totalEntities).toBe(1);
  });

  it('reads entity resource', async () => {
    const entity = brain.entities.create({
      type: 'concept',
      name: 'Test Entity',
      observations: ['fact 1'],
      source: { type: 'manual' },
    });

    const result = await client.readResource({ uri: `brain://entities/${entity.id}` });
    const content = result.contents[0];
    const data = JSON.parse((content as { text: string }).text);
    expect(data.name).toBe('Test Entity');
    expect(data.observations).toContain('fact 1');
  });

  it('reads entities by type resource', async () => {
    brain.entities.create({ type: 'concept', name: 'Concept1', source: { type: 'manual' } });
    brain.entities.create({ type: 'decision', name: 'Decision1', source: { type: 'manual' } });

    const result = await client.readResource({ uri: 'brain://entities/type/concept' });
    const content = result.contents[0];
    const data = JSON.parse((content as { text: string }).text);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Concept1');
  });

  it('reads search resource', async () => {
    brain.entities.create({
      type: 'concept',
      name: 'GraphQL',
      observations: ['Query language'],
      source: { type: 'manual' },
    });

    const result = await client.readResource({ uri: 'brain://search/GraphQL' });
    const content = result.contents[0];
    const data = JSON.parse((content as { text: string }).text);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].entity.name).toBe('GraphQL');
  });
});
