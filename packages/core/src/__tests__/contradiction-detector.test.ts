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

function makeEntity(
  name: string,
  overrides: Partial<CreateEntityInput> = {},
): CreateEntityInput {
  return {
    type: 'concept',
    name,
    source: { type: 'manual' },
    ...overrides,
  };
}

describe('ContradictionDetector', () => {
  describe('getUnresolved', () => {
    it('returns contradicts relations where neither entity is superseded', () => {
      const a = brain.entities.create(makeEntity('API Design A'));
      const b = brain.entities.create(makeEntity('API Design B'));

      brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      const contradictions = brain.contradictions.getUnresolved();
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0].entityA.id).toBe(a.id);
      expect(contradictions[0].entityB.id).toBe(b.id);
      expect(contradictions[0].relation.type).toBe('contradicts');
    });

    it('excludes resolved contradictions (superseded entities)', () => {
      const a = brain.entities.create(makeEntity('Old Approach'));
      const b = brain.entities.create(makeEntity('New Approach'));

      brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      // Supersede A (B wins)
      brain.relations.create({
        type: 'supersedes',
        sourceId: b.id,
        targetId: a.id,
        source: { type: 'manual' },
      });

      const contradictions = brain.contradictions.getUnresolved();
      expect(contradictions).toHaveLength(0);
    });

    it('deduplicates symmetric contradictions', () => {
      const a = brain.entities.create(makeEntity('View A'));
      const b = brain.entities.create(makeEntity('View B'));

      // Create both directions
      brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      // Manually insert reverse to bypass unique constraint (different direction)
      brain.storage.sqlite
        .prepare(
          `INSERT INTO relations (id, type, source_id, target_id, namespace, properties, confidence, weight, bidirectional, source_type, event_time, ingest_time, created_at, updated_at)
           VALUES (?, 'contradicts', ?, ?, 'personal', '{}', 1.0, 1.0, 0, 'manual', ?, ?, ?, ?)`,
        )
        .run(
          'rev-relation-id',
          b.id,
          a.id,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        );

      const contradictions = brain.contradictions.getUnresolved();
      // Should only return 1, not 2
      expect(contradictions).toHaveLength(1);
    });

    it('filters by namespace', () => {
      const a = brain.entities.create(makeEntity('P1', { namespace: 'personal' }));
      const b = brain.entities.create(makeEntity('P2', { namespace: 'personal' }));
      const c = brain.entities.create(makeEntity('X1', { namespace: 'project-x' }));
      const d = brain.entities.create(makeEntity('X2', { namespace: 'project-x' }));

      brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        namespace: 'personal',
        source: { type: 'manual' },
      });
      brain.relations.create({
        type: 'contradicts',
        sourceId: c.id,
        targetId: d.id,
        namespace: 'project-x',
        source: { type: 'manual' },
      });

      const personal = brain.contradictions.getUnresolved('personal');
      expect(personal).toHaveLength(1);
      expect(personal[0].entityA.namespace).toBe('personal');

      const project = brain.contradictions.getUnresolved('project-x');
      expect(project).toHaveLength(1);
      expect(project[0].entityA.namespace).toBe('project-x');
    });
  });

  describe('resolve', () => {
    it('creates supersedes relation and zeros loser confidence', () => {
      const a = brain.entities.create(makeEntity('Winner'));
      const b = brain.entities.create(makeEntity('Loser'));

      const rel = brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      brain.contradictions.resolve(rel.id, a.id);

      // Contradicts relation should be deleted
      expect(brain.relations.get(rel.id)).toBeNull();

      // Supersedes relation should exist
      const outbound = brain.relations.getOutbound(a.id, 'supersedes');
      expect(outbound).toHaveLength(1);
      expect(outbound[0].targetId).toBe(b.id);

      // Loser confidence should be 0
      const loser = brain.entities.get(b.id)!;
      expect(loser.confidence).toBe(0);
    });

    it('works when winner is the target of the contradicts relation', () => {
      const a = brain.entities.create(makeEntity('Source'));
      const b = brain.entities.create(makeEntity('Target Winner'));

      const rel = brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      // Pick b (target) as winner
      brain.contradictions.resolve(rel.id, b.id);

      const outbound = brain.relations.getOutbound(b.id, 'supersedes');
      expect(outbound).toHaveLength(1);
      expect(outbound[0].targetId).toBe(a.id);

      const loser = brain.entities.get(a.id)!;
      expect(loser.confidence).toBe(0);
    });

    it('throws for non-contradicts relation', () => {
      const a = brain.entities.create(makeEntity('A'));
      const b = brain.entities.create(makeEntity('B'));

      const rel = brain.relations.create({
        type: 'relates_to',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      expect(() => brain.contradictions.resolve(rel.id, a.id)).toThrow(
        'not a contradicts relation',
      );
    });
  });

  describe('dismiss', () => {
    it('deletes the contradicts relation', () => {
      const a = brain.entities.create(makeEntity('A'));
      const b = brain.entities.create(makeEntity('B'));

      const rel = brain.relations.create({
        type: 'contradicts',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      brain.contradictions.dismiss(rel.id);

      expect(brain.relations.get(rel.id)).toBeNull();
      // Entities should still exist
      expect(brain.entities.get(a.id)).not.toBeNull();
      expect(brain.entities.get(b.id)).not.toBeNull();
    });

    it('throws for non-contradicts relation', () => {
      const a = brain.entities.create(makeEntity('A'));
      const b = brain.entities.create(makeEntity('B'));

      const rel = brain.relations.create({
        type: 'relates_to',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });

      expect(() => brain.contradictions.dismiss(rel.id)).toThrow(
        'not a contradicts relation',
      );
    });
  });

  describe('detectPotential', () => {
    it('finds same-name-type-namespace entities', () => {
      const a = brain.entities.create(makeEntity('Auth Pattern'));
      brain.entities.create(makeEntity('Auth Pattern'));

      const potential = brain.contradictions.detectPotential(a);
      expect(potential).toHaveLength(1);
      expect(potential[0].name).toBe('Auth Pattern');
      expect(potential[0].id).not.toBe(a.id);
    });

    it('does not match different types', () => {
      const a = brain.entities.create(makeEntity('Caching', { type: 'concept' }));
      brain.entities.create(makeEntity('Caching', { type: 'pattern' }));

      const potential = brain.contradictions.detectPotential(a);
      expect(potential).toHaveLength(0);
    });

    it('does not match different namespaces', () => {
      const a = brain.entities.create(makeEntity('X', { namespace: 'personal' }));
      brain.entities.create(makeEntity('X', { namespace: 'project-y' }));

      const potential = brain.contradictions.detectPotential(a);
      expect(potential).toHaveLength(0);
    });
  });
});
