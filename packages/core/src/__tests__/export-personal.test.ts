import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { Brain } from '../brain.js';
import { exportPersonal } from '../io/export-personal.js';

function makeBrain(): Brain {
  return new Brain({ path: ':memory:', wal: false });
}

describe('exportPersonal', () => {
  let brain: Brain;

  beforeEach(() => {
    brain = makeBrain();
  });

  afterEach(() => {
    brain.close();
  });

  it('returns a valid empty bundle for an empty database', () => {
    const bundle = exportPersonal(brain);

    expect(bundle.version).toBe('1.0');
    expect(bundle.exportedAt).toBeTruthy();
    expect(bundle.entities).toEqual([]);
    expect(bundle.relations).toEqual([]);
    expect(bundle.manifest.danglingEntityIds).toEqual([]);
    expect(bundle.manifest.sourceHostname).toBe(hostname());
    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.sha256).toBe(
      createHash('sha256').update('[][]').digest('hex'),
    );
  });

  it('includes entities in the personal namespace', () => {
    brain.entities.batchUpsert([
      {
        type: 'person',
        name: 'Alice',
        namespace: 'personal',
        observations: ['Knows TypeScript'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);

    const bundle = exportPersonal(brain);
    expect(bundle.entities).toHaveLength(1);
    expect(bundle.entities[0].name).toBe('Alice');
  });

  it('excludes entities in other namespaces', () => {
    brain.entities.batchUpsert([
      {
        type: 'person',
        name: 'Alice',
        namespace: 'personal',
        observations: ['Knows TypeScript'],
        source: { type: 'manual' },
        tags: [],
      },
      {
        type: 'concept',
        name: 'ProjectX',
        namespace: 'proj-123',
        observations: ['A project'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);

    const bundle = exportPersonal(brain);
    expect(bundle.entities).toHaveLength(1);
    expect(bundle.entities[0].name).toBe('Alice');
  });

  it('includes personal relations even when an endpoint is in another namespace', () => {
    const [alice] = brain.entities.batchUpsert([
      {
        type: 'person',
        name: 'Alice',
        namespace: 'personal',
        observations: ['Knows TypeScript'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);
    const [project] = brain.entities.batchUpsert([
      {
        type: 'concept',
        name: 'ProjectX',
        namespace: 'proj-123',
        observations: ['A project'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);

    brain.relations.batchUpsert([
      {
        type: 'uses',
        sourceId: alice.id,
        targetId: project.id,
        namespace: 'personal',
        source: { type: 'manual' },
      },
    ]);

    const bundle = exportPersonal(brain);
    expect(bundle.relations).toHaveLength(1);
    expect(bundle.relations[0].sourceId).toBe(alice.id);
    expect(bundle.relations[0].targetId).toBe(project.id);
  });

  it('correctly identifies dangling entity IDs for cross-namespace references', () => {
    const [alice] = brain.entities.batchUpsert([
      {
        type: 'person',
        name: 'Alice',
        namespace: 'personal',
        observations: ['Knows TypeScript'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);
    const [project] = brain.entities.batchUpsert([
      {
        type: 'concept',
        name: 'ProjectX',
        namespace: 'proj-123',
        observations: ['A project'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);

    brain.relations.batchUpsert([
      {
        type: 'uses',
        sourceId: alice.id,
        targetId: project.id,
        namespace: 'personal',
        source: { type: 'manual' },
      },
    ]);

    const bundle = exportPersonal(brain);
    expect(bundle.manifest.danglingEntityIds).toEqual([project.id]);
  });

  it('produces a consistent sha256 for the same data', () => {
    brain.entities.batchUpsert([
      {
        type: 'person',
        name: 'Alice',
        namespace: 'personal',
        observations: ['Knows TypeScript'],
        source: { type: 'manual' },
        tags: [],
      },
    ]);

    const bundle1 = exportPersonal(brain);
    const bundle2 = exportPersonal(brain);
    expect(bundle1.sha256).toBe(bundle2.sha256);

    const expected = createHash('sha256')
      .update(JSON.stringify(bundle1.entities) + JSON.stringify(bundle1.relations))
      .digest('hex');
    expect(bundle1.sha256).toBe(expected);
  });

  it('sets manifest.sourceHostname', () => {
    const bundle = exportPersonal(brain);
    expect(bundle.manifest.sourceHostname).toBe(hostname());
  });
});
