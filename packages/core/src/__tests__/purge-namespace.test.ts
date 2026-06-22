import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';

function makeBrain(): Brain {
  return new Brain({ path: ':memory:', wal: false });
}

/** Seed two entities (one `watch`-sourced, one `manual`) + one relation in `namespace`. */
function seed(brain: Brain, namespace: string) {
  const [alice, project] = brain.entities.batchUpsert([
    { type: 'person', name: `${namespace}-Alice`, namespace, source: { type: 'watch' } },
    { type: 'concept', name: `${namespace}-Project`, namespace, source: { type: 'manual' } },
  ]);
  brain.relations.batchUpsert([
    {
      type: 'authored_by',
      sourceId: project.id,
      targetId: alice.id,
      namespace,
      source: { type: 'watch' },
    },
  ]);
  return { alice, project };
}

describe('Brain.purgeNamespace', () => {
  let brain: Brain;

  beforeEach(() => {
    brain = makeBrain();
  });

  afterEach(() => {
    brain.close();
  });

  it('deletes every entity and relation in the namespace and reports counts', () => {
    seed(brain, 'projectA');

    const res = brain.purgeNamespace('projectA');

    expect(res).toEqual({ entitiesDeleted: 2, relationsDeleted: 1 });
    expect(brain.entities.count('projectA')).toBe(0);
    expect(brain.relations.listByNamespace('projectA')).toHaveLength(0);
  });

  it('deletes regardless of source_type (manual data is purged too)', () => {
    seed(brain, 'projectA'); // contains both a `watch` and a `manual` entity
    const res = brain.purgeNamespace('projectA');
    expect(res.entitiesDeleted).toBe(2);
  });

  it('leaves other namespaces untouched', () => {
    seed(brain, 'projectA');
    seed(brain, 'projectB');

    brain.purgeNamespace('projectA');

    expect(brain.entities.count('projectA')).toBe(0);
    expect(brain.entities.count('projectB')).toBe(2);
    expect(brain.relations.listByNamespace('projectB')).toHaveLength(1);
  });

  it('returns zero counts for a namespace with no data', () => {
    expect(brain.purgeNamespace('does-not-exist')).toEqual({
      entitiesDeleted: 0,
      relationsDeleted: 0,
    });
  });

  it('rejects an empty namespace', () => {
    expect(() => brain.purgeNamespace('')).toThrow(/non-empty string/);
  });
});
