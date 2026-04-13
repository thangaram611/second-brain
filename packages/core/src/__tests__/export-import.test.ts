import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import { exportJson } from '../io/export-json.js';
import { exportJsonLd } from '../io/export-jsonld.js';
import { exportDot } from '../io/export-dot.js';
import { importGraph } from '../io/import.js';
import type { CreateEntityInput, CreateRelationInput } from '@second-brain/types';

function makeBrain(): Brain {
  return new Brain({ path: ':memory:', wal: false });
}

function seedData(brain: Brain) {
  const alice = brain.entities.batchUpsert([
    {
      type: 'person',
      name: 'Alice',
      namespace: 'personal',
      observations: ['Knows TypeScript', 'Works at ACME'],
      source: { type: 'manual' },
      tags: ['team'],
    },
  ])[0];

  const project = brain.entities.batchUpsert([
    {
      type: 'concept',
      name: 'Second Brain',
      namespace: 'personal',
      observations: ['A knowledge graph project'],
      source: { type: 'manual' },
      tags: ['project'],
    },
  ])[0];

  const decision = brain.entities.batchUpsert([
    {
      type: 'decision',
      name: 'Use SQLite',
      namespace: 'personal',
      observations: ['Chose SQLite for simplicity'],
      source: { type: 'manual' },
      tags: ['architecture'],
    },
  ])[0];

  brain.relations.batchUpsert([
    {
      type: 'authored_by',
      sourceId: project.id,
      targetId: alice.id,
      namespace: 'personal',
      source: { type: 'manual' },
    },
    {
      type: 'decided_in',
      sourceId: decision.id,
      targetId: project.id,
      namespace: 'personal',
      source: { type: 'manual' },
    },
  ]);

  return { alice, project, decision };
}

describe('Import/Export', () => {
  let brain: Brain;

  beforeEach(() => {
    brain = makeBrain();
  });

  afterEach(() => {
    brain.close();
  });

  describe('JSON round-trip', () => {
    it('exports and imports entities and relations', () => {
      const { alice, project, decision } = seedData(brain);

      const json = exportJson(brain, { format: 'json' });
      const parsed = JSON.parse(json);

      expect(parsed.version).toBe('1.0');
      expect(parsed.exportedAt).toBeTruthy();
      expect(parsed.entities).toHaveLength(3);
      expect(parsed.relations).toHaveLength(2);

      // Import into fresh brain
      const brain2 = makeBrain();
      const result = importGraph(brain2, json, {
        format: 'json',
        strategy: 'upsert',
      });

      expect(result.entitiesImported).toBe(3);
      expect(result.relationsImported).toBe(2);
      expect(result.conflicts).toHaveLength(0);

      // Verify entities
      const importedEntities = brain2.entities.list();
      expect(importedEntities).toHaveLength(3);

      const names = importedEntities.map((e) => e.name).sort();
      expect(names).toEqual(['Alice', 'Second Brain', 'Use SQLite']);

      const aliceImported = importedEntities.find((e) => e.name === 'Alice');
      expect(aliceImported).toBeTruthy();
      expect(aliceImported!.type).toBe('person');
      expect(aliceImported!.observations).toEqual(['Knows TypeScript', 'Works at ACME']);
      expect(aliceImported!.tags).toEqual(['team']);

      // Verify relations exist (check via outbound)
      const projectImported = importedEntities.find((e) => e.name === 'Second Brain');
      expect(projectImported).toBeTruthy();
      const outbound = brain2.relations.getOutbound(projectImported!.id);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].type).toBe('authored_by');

      brain2.close();
    });

    it('filters by namespace', () => {
      seedData(brain);
      brain.entities.batchUpsert([
        {
          type: 'concept',
          name: 'Other Thing',
          namespace: 'work',
          source: { type: 'manual' },
        },
      ]);

      const json = exportJson(brain, { format: 'json', namespace: 'personal' });
      const parsed = JSON.parse(json);
      expect(parsed.entities).toHaveLength(3);
    });

    it('filters by entity types', () => {
      seedData(brain);
      const json = exportJson(brain, { format: 'json', types: ['person'] });
      const parsed = JSON.parse(json);
      expect(parsed.entities).toHaveLength(1);
      expect(parsed.entities[0].name).toBe('Alice');
    });

    it('excludes relations when includeRelations is false', () => {
      seedData(brain);
      const json = exportJson(brain, { format: 'json', includeRelations: false });
      const parsed = JSON.parse(json);
      expect(parsed.relations).toHaveLength(0);
    });
  });

  describe('JSON-LD round-trip', () => {
    it('exports and imports via JSON-LD', () => {
      seedData(brain);

      const jsonLd = exportJsonLd(brain, { format: 'json-ld' });
      const parsed = JSON.parse(jsonLd);

      expect(parsed['@context']).toBeTruthy();
      expect(parsed['@graph']).toHaveLength(5); // 3 entities + 2 relations

      // Verify person mapped to schema.org Person
      const personNode = parsed['@graph'].find(
        (n: Record<string, unknown>) => n['@type'] === 'Person',
      );
      expect(personNode).toBeTruthy();
      expect(personNode['brain:name']).toBe('Alice');

      // Verify concept mapped to brain:concept
      const conceptNode = parsed['@graph'].find(
        (n: Record<string, unknown>) => n['@type'] === 'brain:concept',
      );
      expect(conceptNode).toBeTruthy();

      // Import into fresh brain
      const brain2 = makeBrain();
      const result = importGraph(brain2, jsonLd, {
        format: 'json-ld',
        strategy: 'upsert',
      });

      expect(result.entitiesImported).toBe(3);
      expect(result.relationsImported).toBe(2);

      const importedEntities = brain2.entities.list();
      const names = importedEntities.map((e) => e.name).sort();
      expect(names).toEqual(['Alice', 'Second Brain', 'Use SQLite']);

      const alice = importedEntities.find((e) => e.name === 'Alice');
      expect(alice!.type).toBe('person');
      expect(alice!.observations).toEqual(['Knows TypeScript', 'Works at ACME']);

      brain2.close();
    });
  });

  describe('DOT export', () => {
    it('produces valid DOT structure', () => {
      seedData(brain);

      const dot = exportDot(brain, { format: 'dot' });

      expect(dot).toContain('digraph brain {');
      expect(dot).toContain('rankdir=LR;');
      expect(dot).toContain('shape=octagon'); // person
      expect(dot).toContain('shape=ellipse'); // concept
      expect(dot).toContain('shape=diamond'); // decision
      expect(dot).toContain('label="Alice"');
      expect(dot).toContain('label="authored_by"');
      expect(dot).toContain('label="decided_in"');
      expect(dot).toMatch(/->.*\[label=/); // edges present
      expect(dot.trim().endsWith('}')).toBe(true);
    });

    it('escapes special characters in names', () => {
      brain.entities.batchUpsert([
        {
          type: 'concept',
          name: 'He said "hello"',
          namespace: 'personal',
          source: { type: 'manual' },
        },
      ]);

      const dot = exportDot(brain, { format: 'dot' });
      expect(dot).toContain('He said \\"hello\\"');
    });
  });

  describe('Import strategies', () => {
    it('merge skips existing entities and reports conflicts', () => {
      seedData(brain);

      const json = exportJson(brain, { format: 'json' });

      // Import with merge into the SAME brain
      const result = importGraph(brain, json, {
        format: 'json',
        strategy: 'merge',
      });

      // All 3 should be conflicts (already exist)
      expect(result.conflicts).toHaveLength(3);
      expect(result.entitiesImported).toBe(0);
      expect(result.conflicts[0].reason).toContain('already exists');
    });

    it('replace deletes existing data before import', () => {
      seedData(brain);
      expect(brain.entities.count()).toBe(3);

      // Export then re-import only one entity
      const json = exportJson(brain, { format: 'json', types: ['person'] });

      const result = importGraph(brain, json, {
        format: 'json',
        strategy: 'replace',
        namespace: 'personal',
      });

      expect(result.entitiesImported).toBe(1);
      expect(brain.entities.count('personal')).toBe(1);
      const entities = brain.entities.list();
      expect(entities[0].name).toBe('Alice');
    });

    it('upsert with namespace override', () => {
      seedData(brain);
      const json = exportJson(brain, { format: 'json' });

      const brain2 = makeBrain();
      const result = importGraph(brain2, json, {
        format: 'json',
        strategy: 'upsert',
        namespace: 'imported',
      });

      expect(result.entitiesImported).toBe(3);
      const entities = brain2.entities.list({ namespace: 'imported' });
      expect(entities).toHaveLength(3);

      brain2.close();
    });
  });
});
