import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import type { CreateEntityInput } from '@second-brain/types';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function makeConcept(name: string, obs: string[] = []): CreateEntityInput {
  return {
    type: 'concept',
    name,
    observations: obs,
    source: { type: 'manual' },
  };
}

describe('EntityManager', () => {
  describe('create', () => {
    it('creates an entity with defaults', () => {
      const entity = brain.entities.create(makeConcept('CRDT'));

      expect(entity.id).toBeTruthy();
      expect(entity.type).toBe('concept');
      expect(entity.name).toBe('CRDT');
      expect(entity.namespace).toBe('personal');
      expect(entity.confidence).toBe(1.0);
      expect(entity.accessCount).toBe(0);
      expect(entity.source.type).toBe('manual');
    });

    it('creates an entity with observations and tags', () => {
      const entity = brain.entities.create({
        ...makeConcept('Event Sourcing', ['Stores all changes as events']),
        tags: ['architecture', 'data'],
      });

      expect(entity.observations).toEqual(['Stores all changes as events']);
      expect(entity.tags).toEqual(['architecture', 'data']);
    });
  });

  describe('get', () => {
    it('returns null for nonexistent id', () => {
      expect(brain.entities.get('nonexistent')).toBeNull();
    });

    it('retrieves a created entity by id', () => {
      const created = brain.entities.create(makeConcept('GraphQL'));
      const fetched = brain.entities.get(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('GraphQL');
    });
  });

  describe('update', () => {
    it('updates entity fields', () => {
      const entity = brain.entities.create(makeConcept('REST API'));
      const updated = brain.entities.update(entity.id, {
        name: 'REST API v2',
        confidence: 0.8,
        tags: ['api'],
      });

      expect(updated!.name).toBe('REST API v2');
      expect(updated!.confidence).toBe(0.8);
      expect(updated!.tags).toEqual(['api']);
    });

    it('returns null for nonexistent id', () => {
      expect(brain.entities.update('nonexistent', { name: 'x' })).toBeNull();
    });

    it('mutates namespace when patch.namespace is set', () => {
      const entity = brain.entities.create({
        ...makeConcept('Moved'),
        namespace: 'session:abc',
      });
      const updated = brain.entities.update(entity.id, { namespace: 'personal' });

      expect(updated!.namespace).toBe('personal');
      expect(updated!.id).toBe(entity.id);
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(entity.updatedAt).getTime(),
      );
    });
  });

  describe('delete', () => {
    it('deletes an entity', () => {
      const entity = brain.entities.create(makeConcept('Temp'));
      expect(brain.entities.delete(entity.id)).toBe(true);
      expect(brain.entities.get(entity.id)).toBeNull();
    });

    it('returns false for nonexistent id', () => {
      expect(brain.entities.delete('nonexistent')).toBe(false);
    });
  });

  describe('addObservation / removeObservation', () => {
    it('appends and removes observations', () => {
      const entity = brain.entities.create(makeConcept('TypeScript', ['Typed JS']));

      const withNew = brain.entities.addObservation(entity.id, 'Supports generics');
      expect(withNew!.observations).toEqual(['Typed JS', 'Supports generics']);

      const withRemoved = brain.entities.removeObservation(entity.id, 'Typed JS');
      expect(withRemoved!.observations).toEqual(['Supports generics']);
    });
  });

  describe('batchUpsert', () => {
    it('creates new entities', () => {
      const results = brain.entities.batchUpsert([
        makeConcept('A'),
        makeConcept('B'),
      ]);
      expect(results).toHaveLength(2);
      expect(brain.entities.count()).toBe(2);
    });

    it('merges duplicate entities by name+namespace+type', () => {
      brain.entities.create(makeConcept('CRDT', ['fact 1']));
      const results = brain.entities.batchUpsert([
        { ...makeConcept('CRDT', ['fact 2']), tags: ['sync'] },
      ]);

      expect(results).toHaveLength(1);
      expect(brain.entities.count()).toBe(1);
      expect(results[0].observations).toContain('fact 1');
      expect(results[0].observations).toContain('fact 2');
      expect(results[0].tags).toContain('sync');
    });
  });

  describe('findByName / findByType', () => {
    it('finds entities by partial name match', () => {
      brain.entities.create(makeConcept('React Hooks'));
      brain.entities.create(makeConcept('React Router'));
      brain.entities.create(makeConcept('Vue.js'));

      const results = brain.entities.findByName('React');
      expect(results).toHaveLength(2);
    });

    it('finds entities by type', () => {
      brain.entities.create(makeConcept('A'));
      brain.entities.create({ ...makeConcept('B'), type: 'decision' } as CreateEntityInput);

      const concepts = brain.entities.findByType('concept');
      expect(concepts).toHaveLength(1);
      expect(concepts[0].name).toBe('A');
    });
  });

  describe('touch', () => {
    it('increments access count', () => {
      const entity = brain.entities.create(makeConcept('Test'));
      expect(entity.accessCount).toBe(0);

      brain.entities.touch(entity.id);
      brain.entities.touch(entity.id);

      const updated = brain.entities.get(entity.id);
      expect(updated!.accessCount).toBe(2);
    });
  });

  describe('namespace isolation', () => {
    it('separates entities by namespace', () => {
      brain.entities.create({ ...makeConcept('A'), namespace: 'personal' });
      brain.entities.create({ ...makeConcept('B'), namespace: 'project-x' });

      expect(brain.entities.findByType('concept', 'personal')).toHaveLength(1);
      expect(brain.entities.findByType('concept', 'project-x')).toHaveLength(1);
      expect(brain.entities.findByType('concept')).toHaveLength(2);
    });
  });

  describe('listByBranchContext (migration 002 generated columns)', () => {
    it('returns entities whose properties.branchContext.branch matches', () => {
      brain.entities.create({
        type: 'event',
        name: 'edit:a',
        namespace: 'proj',
        properties: { branchContext: { branch: 'feature/a', status: 'wip' } },
        source: { type: 'watch' },
      });
      brain.entities.create({
        type: 'event',
        name: 'edit:b',
        namespace: 'proj',
        properties: { branchContext: { branch: 'feature/b', status: 'wip' } },
        source: { type: 'watch' },
      });
      brain.entities.create({
        type: 'event',
        name: 'edit:c',
        namespace: 'proj',
        properties: { branchContext: { branch: 'feature/a', status: 'merged' } },
        source: { type: 'watch' },
      });

      const featA = brain.entities.listByBranchContext('feature/a');
      expect(featA).toHaveLength(2);
      expect(featA.map((e) => e.name).sort()).toEqual(['edit:a', 'edit:c']);

      const featAWip = brain.entities.listByBranchContext('feature/a', { status: 'wip' });
      expect(featAWip).toHaveLength(1);
      expect(featAWip[0].name).toBe('edit:a');
    });

    it('filters by namespace when provided', () => {
      brain.entities.create({
        type: 'event',
        name: 'in-proj',
        namespace: 'proj',
        properties: { branchContext: { branch: 'feature/x', status: 'wip' } },
        source: { type: 'watch' },
      });
      brain.entities.create({
        type: 'event',
        name: 'in-personal',
        namespace: 'personal',
        properties: { branchContext: { branch: 'feature/x', status: 'wip' } },
        source: { type: 'watch' },
      });

      const inProj = brain.entities.listByBranchContext('feature/x', { namespace: 'proj' });
      expect(inProj).toHaveLength(1);
      expect(inProj[0].namespace).toBe('proj');
    });

    it('returns [] for an unknown branch', () => {
      brain.entities.create({
        type: 'event',
        name: 'x',
        namespace: 'proj',
        properties: { branchContext: { branch: 'feature/real', status: 'wip' } },
        source: { type: 'watch' },
      });
      expect(brain.entities.listByBranchContext('feature/ghost')).toHaveLength(0);
    });
  });

  describe('findByTypeAndProperty', () => {
    it('matches on numeric property equality', () => {
      brain.entities.create({
        type: 'merge_request',
        name: 'acme/repo!42',
        namespace: 'proj',
        properties: { iid: 42, projectId: 'acme/repo', title: 'Add feature' },
        source: { type: 'gitlab' },
      });
      const rows = brain.entities.findByTypeAndProperty('merge_request', '$.iid', 42, 'proj');
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('acme/repo!42');
    });

    it('matches on string property equality', () => {
      brain.entities.create({
        type: 'merge_request',
        name: 'acme/repo!7',
        namespace: 'proj',
        properties: { iid: 7, projectId: 'acme/repo' },
        source: { type: 'gitlab' },
      });
      const rows = brain.entities.findByTypeAndProperty('merge_request', '$.projectId', 'acme/repo');
      expect(rows).toHaveLength(1);
    });

    it('returns the same entity across title edits (stable key)', () => {
      const mr = brain.entities.create({
        type: 'merge_request',
        name: 'acme/repo!11',
        namespace: 'proj',
        properties: { iid: 11, projectId: 'acme/repo', title: 'WIP: draft' },
        source: { type: 'gitlab' },
      });
      brain.entities.update(mr.id, {
        properties: { iid: 11, projectId: 'acme/repo', title: 'Release: v2' },
      });
      const rows = brain.entities.findByTypeAndProperty('merge_request', '$.iid', 11, 'proj');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(mr.id);
    });

    it('returns [] when no entity matches', () => {
      expect(
        brain.entities.findByTypeAndProperty('merge_request', '$.iid', 999, 'proj'),
      ).toHaveLength(0);
    });

    it('filters by type — same property on different type is ignored', () => {
      brain.entities.create({
        type: 'pull_request',
        name: 'acme/repo#3',
        namespace: 'proj',
        properties: { iid: 3 },
        source: { type: 'github' },
      });
      const rows = brain.entities.findByTypeAndProperty('merge_request', '$.iid', 3, 'proj');
      expect(rows).toHaveLength(0);
    });
  });
});
