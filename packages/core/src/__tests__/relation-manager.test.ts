import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import type { Entity } from '@second-brain/types';

let brain: Brain;
let entityA: Entity;
let entityB: Entity;
let entityC: Entity;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });

  entityA = brain.entities.create({
    type: 'concept',
    name: 'A',
    source: { type: 'manual' },
  });
  entityB = brain.entities.create({
    type: 'concept',
    name: 'B',
    source: { type: 'manual' },
  });
  entityC = brain.entities.create({
    type: 'concept',
    name: 'C',
    source: { type: 'manual' },
  });
});

afterEach(() => {
  brain.close();
});

describe('RelationManager', () => {
  describe('create / get / delete', () => {
    it('creates a relation between entities', () => {
      const rel = brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });

      expect(rel.id).toBeTruthy();
      expect(rel.type).toBe('depends_on');
      expect(rel.sourceId).toBe(entityA.id);
      expect(rel.targetId).toBe(entityB.id);
      expect(rel.confidence).toBe(1.0);
      expect(rel.weight).toBe(1.0);
    });

    it('retrieves a relation by id', () => {
      const rel = brain.relations.create({
        type: 'relates_to',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });

      const fetched = brain.relations.get(rel.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.type).toBe('relates_to');
    });

    it('deletes a relation', () => {
      const rel = brain.relations.create({
        type: 'relates_to',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });

      expect(brain.relations.delete(rel.id)).toBe(true);
      expect(brain.relations.get(rel.id)).toBeNull();
    });

    it('updates relation namespace while preserving ID-based lookups', () => {
      const rel = brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        namespace: 'session:abc',
        source: { type: 'conversation' },
      });

      const updated = brain.relations.update(rel.id, { namespace: 'personal' });
      expect(updated!.namespace).toBe('personal');
      // ID-based traversals still resolve
      expect(brain.relations.getOutbound(entityA.id).map((r) => r.id)).toContain(rel.id);
      expect(brain.relations.getInbound(entityB.id).map((r) => r.id)).toContain(rel.id);
    });

    it('listByNamespace returns only relations in the given namespace', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        namespace: 'session:one',
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'uses',
        sourceId: entityA.id,
        targetId: entityC.id,
        namespace: 'personal',
        source: { type: 'manual' },
      });

      expect(brain.relations.listByNamespace('session:one')).toHaveLength(1);
      expect(brain.relations.listByNamespace('personal')).toHaveLength(1);
    });
  });

  describe('getOutbound / getInbound', () => {
    it('returns outbound relations', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'uses',
        sourceId: entityA.id,
        targetId: entityC.id,
        source: { type: 'manual' },
      });

      const outbound = brain.relations.getOutbound(entityA.id);
      expect(outbound).toHaveLength(2);
    });

    it('filters outbound by type', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'uses',
        sourceId: entityA.id,
        targetId: entityC.id,
        source: { type: 'manual' },
      });

      const deps = brain.relations.getOutbound(entityA.id, 'depends_on');
      expect(deps).toHaveLength(1);
      expect(deps[0].targetId).toBe(entityB.id);
    });

    it('returns inbound relations', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });

      const inbound = brain.relations.getInbound(entityB.id);
      expect(inbound).toHaveLength(1);
      expect(inbound[0].sourceId).toBe(entityA.id);
    });
  });

  describe('getNeighbors', () => {
    it('returns depth-1 neighbors', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityB.id,
        targetId: entityC.id,
        source: { type: 'manual' },
      });

      const { entities, relations } = brain.traversal.getNeighbors(entityA.id, 1);
      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe(entityB.id);
      expect(relations).toHaveLength(1);
    });

    it('returns depth-2 neighbors', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityB.id,
        targetId: entityC.id,
        source: { type: 'manual' },
      });

      const { entities } = brain.traversal.getNeighbors(entityA.id, 2);
      expect(entities).toHaveLength(2);
      const names = entities.map((e) => e.name).sort();
      expect(names).toEqual(['B', 'C']);
    });
  });

  describe('findPath', () => {
    it('finds a direct path', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });

      const paths = brain.traversal.findPath(entityA.id, entityB.id);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toHaveLength(1);
      expect(paths[0][0].type).toBe('depends_on');
    });

    it('finds a multi-hop path', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'uses',
        sourceId: entityB.id,
        targetId: entityC.id,
        source: { type: 'manual' },
      });

      const paths = brain.traversal.findPath(entityA.id, entityC.id);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toHaveLength(2);
    });

    it('returns empty when no path exists', () => {
      const paths = brain.traversal.findPath(entityA.id, entityC.id);
      expect(paths).toHaveLength(0);
    });
  });

  describe('batchUpsert', () => {
    it('creates new relations', () => {
      const results = brain.relations.batchUpsert([
        {
          type: 'depends_on',
          sourceId: entityA.id,
          targetId: entityB.id,
          source: { type: 'manual' },
        },
        {
          type: 'uses',
          sourceId: entityA.id,
          targetId: entityC.id,
          source: { type: 'manual' },
        },
      ]);
      expect(results).toHaveLength(2);
    });

    it('upserts existing relations', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        weight: 0.5,
        source: { type: 'manual' },
      });

      const results = brain.relations.batchUpsert([
        {
          type: 'depends_on',
          sourceId: entityA.id,
          targetId: entityB.id,
          weight: 0.9,
          source: { type: 'manual' },
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].weight).toBe(0.9);
      expect(brain.relations.count()).toBe(1);
    });
  });

  describe('cascade delete', () => {
    it('deletes relations when entity is deleted', () => {
      brain.relations.create({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });

      expect(brain.relations.count()).toBe(1);
      brain.entities.delete(entityA.id);
      expect(brain.relations.count()).toBe(0);
    });
  });

  describe('createOrGet', () => {
    it('creates the relation on first call', () => {
      const before = brain.relations.count();
      const rel = brain.relations.createOrGet({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      expect(rel.id).toBeTruthy();
      expect(brain.relations.count()).toBe(before + 1);
    });

    it('returns the existing row without creating a duplicate', () => {
      const first = brain.relations.createOrGet({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      const before = brain.relations.count();
      const second = brain.relations.createOrGet({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'gitlab', actor: 'late-writer' },
        weight: 0.5,
      });
      expect(second.id).toBe(first.id);
      expect(second.source.actor).toBe(first.source.actor ?? undefined);
      expect(second.weight).toBe(first.weight);
      expect(brain.relations.count()).toBe(before);
    });

    it('scopes uniqueness per (source, target, type) — different type creates a new row', () => {
      brain.relations.createOrGet({
        type: 'depends_on',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      const other = brain.relations.createOrGet({
        type: 'relates_to',
        sourceId: entityA.id,
        targetId: entityB.id,
        source: { type: 'manual' },
      });
      expect(other.type).toBe('relates_to');
      expect(brain.relations.count()).toBe(2);
    });
  });
});
