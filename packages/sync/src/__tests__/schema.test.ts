import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import type { Entity, Relation } from '@second-brain/types';
import {
  createBrainDoc,
  entityToYMap,
  yMapToEntity,
  relationToYMap,
  yMapToRelation,
  setObservations,
  getObservations,
  setTags,
  getTags,
} from '../crdt/schema.js';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'ent-001',
    type: 'concept',
    name: 'CRDT',
    namespace: 'team-a',
    observations: ['Conflict-free replicated data type', 'Used in real-time sync'],
    properties: { language: 'TypeScript', maturity: 'high' },
    confidence: 0.95,
    eventTime: '2025-01-01T00:00:00.000Z',
    ingestTime: '2025-01-01T00:00:01.000Z',
    lastAccessedAt: '2025-06-01T00:00:00.000Z',
    accessCount: 5,
    source: { type: 'manual', ref: 'doc-123', actor: 'user-1' },
    tags: ['sync', 'distributed'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRelation(overrides: Partial<Relation> = {}): Relation {
  return {
    id: 'rel-001',
    type: 'relates_to',
    sourceId: 'ent-001',
    targetId: 'ent-002',
    namespace: 'team-a',
    properties: { strength: 'strong' },
    confidence: 0.9,
    weight: 1.5,
    bidirectional: true,
    source: { type: 'inferred', actor: 'agent-1' },
    eventTime: '2025-02-01T00:00:00.000Z',
    ingestTime: '2025-02-01T00:00:01.000Z',
    createdAt: '2025-02-01T00:00:00.000Z',
    updatedAt: '2025-02-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createBrainDoc', () => {
  it('creates a Y.Doc with entities, relations, and meta maps', () => {
    const doc = createBrainDoc();
    expect(doc.getMap('entities')).toBeDefined();
    expect(doc.getMap('relations')).toBeDefined();
    expect(doc.getMap('meta').get('version')).toBe(1);
    expect(typeof doc.getMap('meta').get('lastModified')).toBe('string');
    doc.destroy();
  });
});

describe('entityToYMap / yMapToEntity round-trip', () => {
  it('round-trips an entity through Y.Doc', () => {
    const doc = createBrainDoc();
    const entity = makeEntity();

    entityToYMap(doc, entity);

    const entitiesMap = doc.getMap('entities');
    const yMap = entitiesMap.get(entity.id);
    expect(yMap).toBeInstanceOf(Y.Map);

    if (yMap instanceof Y.Map) {
      const result = yMapToEntity(yMap);
      expect(result).toEqual(entity);
    }

    doc.destroy();
  });

  it('round-trips entity with empty observations and tags', () => {
    const doc = createBrainDoc();
    const entity = makeEntity({ observations: [], tags: [] });

    entityToYMap(doc, entity);

    const yMap = doc.getMap('entities').get(entity.id);
    if (yMap instanceof Y.Map) {
      const result = yMapToEntity(yMap);
      expect(result.observations).toEqual([]);
      expect(result.tags).toEqual([]);
    }

    doc.destroy();
  });

  it('round-trips entity without optional source fields', () => {
    const doc = createBrainDoc();
    const entity = makeEntity({
      source: { type: 'git' },
    });

    entityToYMap(doc, entity);

    const yMap = doc.getMap('entities').get(entity.id);
    if (yMap instanceof Y.Map) {
      const result = yMapToEntity(yMap);
      expect(result.source).toEqual({ type: 'git', ref: undefined, actor: undefined });
    }

    doc.destroy();
  });

  it('throws on invalid entity type', () => {
    const doc = createBrainDoc();
    const entitiesMap = doc.getMap('entities');
    const badMap = new Y.Map<unknown>();
    badMap.set('id', 'bad-1');
    badMap.set('type', 'nonexistent_type');
    badMap.set('name', 'Bad');
    badMap.set('namespace', 'test');
    entitiesMap.set('bad-1', badMap);

    const yMap = entitiesMap.get('bad-1');
    if (yMap instanceof Y.Map) {
      expect(() => yMapToEntity(yMap)).toThrow('Invalid entity type');
    }

    doc.destroy();
  });

  it('preserves all entity types', () => {
    const doc = createBrainDoc();
    const types = ['concept', 'decision', 'pattern', 'person', 'file', 'symbol', 'event', 'tool', 'fact', 'conversation', 'reference'] as const;

    for (const type of types) {
      const entity = makeEntity({ id: `ent-${type}`, type });
      entityToYMap(doc, entity);

      const yMap = doc.getMap('entities').get(entity.id);
      if (yMap instanceof Y.Map) {
        const result = yMapToEntity(yMap);
        expect(result.type).toBe(type);
      }
    }

    doc.destroy();
  });
});

describe('relationToYMap / yMapToRelation round-trip', () => {
  it('round-trips a relation through Y.Doc', () => {
    const doc = createBrainDoc();
    const relation = makeRelation();

    relationToYMap(doc, relation);

    const relationsMap = doc.getMap('relations');
    const yMap = relationsMap.get(relation.id);
    expect(yMap).toBeInstanceOf(Y.Map);

    if (yMap instanceof Y.Map) {
      const result = yMapToRelation(yMap);
      expect(result).toEqual(relation);
    }

    doc.destroy();
  });

  it('round-trips relation with empty properties', () => {
    const doc = createBrainDoc();
    const relation = makeRelation({ properties: {} });

    relationToYMap(doc, relation);

    const yMap = doc.getMap('relations').get(relation.id);
    if (yMap instanceof Y.Map) {
      const result = yMapToRelation(yMap);
      expect(result.properties).toEqual({});
    }

    doc.destroy();
  });

  it('throws on invalid relation type', () => {
    const doc = createBrainDoc();
    const relationsMap = doc.getMap('relations');
    const badMap = new Y.Map<unknown>();
    badMap.set('id', 'bad-1');
    badMap.set('type', 'fake_relation');
    relationsMap.set('bad-1', badMap);

    const yMap = relationsMap.get('bad-1');
    if (yMap instanceof Y.Map) {
      expect(() => yMapToRelation(yMap)).toThrow('Invalid relation type');
    }

    doc.destroy();
  });
});

describe('setObservations / getObservations', () => {
  it('sets and gets observations as a set', () => {
    const doc = createBrainDoc();
    const entity = makeEntity();
    entityToYMap(doc, entity);

    const yMap = doc.getMap('entities').get(entity.id);
    if (yMap instanceof Y.Map) {
      const obs = getObservations(yMap);
      expect(obs).toContain('Conflict-free replicated data type');
      expect(obs).toContain('Used in real-time sync');
      expect(obs).toHaveLength(2);

      // Replace observations
      setObservations(yMap, ['New observation']);
      expect(getObservations(yMap)).toEqual(['New observation']);
    }

    doc.destroy();
  });

  it('handles empty observations', () => {
    const doc = createBrainDoc();
    const entity = makeEntity({ observations: [] });
    entityToYMap(doc, entity);

    const yMap = doc.getMap('entities').get(entity.id);
    if (yMap instanceof Y.Map) {
      expect(getObservations(yMap)).toEqual([]);
      setObservations(yMap, ['First']);
      expect(getObservations(yMap)).toEqual(['First']);
    }

    doc.destroy();
  });

  it('deduplicates observations naturally via set pattern', () => {
    const doc = createBrainDoc();
    const entity = makeEntity();
    entityToYMap(doc, entity);

    const yMap = doc.getMap('entities').get(entity.id);
    if (yMap instanceof Y.Map) {
      setObservations(yMap, ['dup', 'dup', 'unique']);
      // Y.Map set pattern means 'dup' key is set twice to true — no duplicates in keys
      expect(getObservations(yMap)).toContain('dup');
      expect(getObservations(yMap)).toContain('unique');
      expect(getObservations(yMap)).toHaveLength(2);
    }

    doc.destroy();
  });
});

describe('setTags / getTags', () => {
  it('sets and gets tags', () => {
    const doc = createBrainDoc();
    const entity = makeEntity();
    entityToYMap(doc, entity);

    const yMap = doc.getMap('entities').get(entity.id);
    if (yMap instanceof Y.Map) {
      const tags = getTags(yMap);
      expect(tags).toContain('sync');
      expect(tags).toContain('distributed');

      setTags(yMap, ['new-tag']);
      expect(getTags(yMap)).toEqual(['new-tag']);
    }

    doc.destroy();
  });
});

describe('Y.Doc sync between two docs', () => {
  it('syncs entity from doc1 to doc2 via Y.applyUpdate', () => {
    const doc1 = createBrainDoc();
    const doc2 = createBrainDoc();

    const entity = makeEntity();
    doc1.transact(() => {
      entityToYMap(doc1, entity);
    });

    // Simulate sync: get state vector from doc2, compute diff from doc1
    const stateVector = Y.encodeStateVector(doc2);
    const update = Y.encodeStateAsUpdate(doc1, stateVector);
    Y.applyUpdate(doc2, update);

    // doc2 should now have the entity
    const yMap = doc2.getMap('entities').get(entity.id);
    expect(yMap).toBeInstanceOf(Y.Map);
    if (yMap instanceof Y.Map) {
      const result = yMapToEntity(yMap);
      expect(result.id).toBe(entity.id);
      expect(result.name).toBe(entity.name);
    }

    doc1.destroy();
    doc2.destroy();
  });
});
