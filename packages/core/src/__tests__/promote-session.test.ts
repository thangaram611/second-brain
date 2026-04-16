import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import { sessionNamespace } from '@second-brain/types';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

describe('Brain.promoteSession', () => {
  it('rewrites entity and relation namespaces from session to target', () => {
    const sessionId = 'abc';
    const ns = sessionNamespace(sessionId);

    const a = brain.entities.create({
      type: 'decision',
      name: 'Use Postgres',
      namespace: ns,
      source: { type: 'conversation' },
    });
    const b = brain.entities.create({
      type: 'fact',
      name: 'Postgres supports JSON',
      namespace: ns,
      source: { type: 'conversation' },
    });
    brain.relations.create({
      type: 'derived_from',
      sourceId: a.id,
      targetId: b.id,
      namespace: ns,
      source: { type: 'conversation' },
    });

    expect(brain.entities.count(ns)).toBe(2);
    expect(brain.relations.count(ns)).toBe(1);

    const result = brain.promoteSession(sessionId, 'personal');

    expect(result.promotedEntities).toBe(2);
    expect(result.promotedRelations).toBe(1);
    expect(result.skipped).toBe(0);
    expect(brain.entities.count(ns)).toBe(0);
    expect(brain.relations.count(ns)).toBe(0);
    expect(brain.entities.count('personal')).toBe(2);
    expect(brain.relations.count('personal')).toBe(1);
  });

  it('keeps dangling relations in session namespace when only one endpoint promotes', () => {
    const sessionId = 'dangling';
    const ns = sessionNamespace(sessionId);

    // A is in session, X is outside
    const a = brain.entities.create({
      type: 'concept',
      name: 'A',
      namespace: ns,
      source: { type: 'manual' },
    });
    const x = brain.entities.create({
      type: 'concept',
      name: 'X',
      namespace: 'personal',
      source: { type: 'manual' },
    });
    // Relation lives in session but spans both namespaces
    brain.relations.create({
      type: 'relates_to',
      sourceId: a.id,
      targetId: x.id,
      namespace: ns,
      source: { type: 'manual' },
    });

    const result = brain.promoteSession(sessionId, 'personal');

    expect(result.promotedEntities).toBe(1);
    expect(result.promotedRelations).toBe(0);
    expect(result.skipped).toBe(1);
    expect(brain.relations.count(ns)).toBe(1);
  });

  it('is idempotent — second promotion promotes nothing', () => {
    const sessionId = 'idem';
    const ns = sessionNamespace(sessionId);

    brain.entities.create({
      type: 'concept',
      name: 'One',
      namespace: ns,
      source: { type: 'manual' },
    });

    const first = brain.promoteSession(sessionId, 'personal');
    const second = brain.promoteSession(sessionId, 'personal');

    expect(first.promotedEntities).toBe(1);
    expect(second.promotedEntities).toBe(0);
  });

  it('honors entityTypeFilter', () => {
    const sessionId = 'filtered';
    const ns = sessionNamespace(sessionId);

    brain.entities.create({
      type: 'decision',
      name: 'd1',
      namespace: ns,
      source: { type: 'conversation' },
    });
    brain.entities.create({
      type: 'event',
      name: 'e1',
      namespace: ns,
      source: { type: 'conversation' },
    });

    const result = brain.promoteSession(sessionId, 'personal', {
      entityTypeFilter: ['decision'],
    });

    expect(result.promotedEntities).toBe(1);
    expect(brain.entities.count('personal')).toBe(1);
    expect(brain.entities.count(ns)).toBe(1); // event stays
  });

  it('preserves graph shape across promotion (IDs stable, neighbors reachable)', () => {
    const sessionId = 'graph';
    const ns = sessionNamespace(sessionId);

    const a = brain.entities.create({
      type: 'concept',
      name: 'A',
      namespace: ns,
      source: { type: 'manual' },
    });
    const b = brain.entities.create({
      type: 'concept',
      name: 'B',
      namespace: ns,
      source: { type: 'manual' },
    });
    const c = brain.entities.create({
      type: 'concept',
      name: 'C',
      namespace: ns,
      source: { type: 'manual' },
    });
    brain.relations.create({
      type: 'depends_on',
      sourceId: a.id,
      targetId: b.id,
      namespace: ns,
      source: { type: 'manual' },
    });
    brain.relations.create({
      type: 'depends_on',
      sourceId: b.id,
      targetId: c.id,
      namespace: ns,
      source: { type: 'manual' },
    });

    const before = brain.traversal.getNeighbors(a.id, 2);
    expect(before.entities.map((e) => e.id).sort()).toEqual([b.id, c.id].sort());

    brain.promoteSession(sessionId, 'personal');

    const after = brain.traversal.getNeighbors(a.id, 2);
    expect(after.entities.map((e) => e.id).sort()).toEqual([b.id, c.id].sort());
    // All entities have moved
    expect(after.entities.every((e) => e.namespace === 'personal')).toBe(true);
  });
});
