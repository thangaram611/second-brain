import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Brain } from '../brain.js';
import { exportPersonal } from '../io/export-personal.js';
import { importPersonal } from '../io/import-personal.js';
import type { PersonalBundle } from '../io/types.js';

function makeBrain(): Brain {
  return new Brain({ path: ':memory:', wal: false });
}

function seedPersonalEntity(brain: Brain, name: string, type: 'person' | 'concept' = 'person') {
  return brain.entities.batchUpsert([
    {
      type,
      name,
      namespace: 'personal',
      observations: [`About ${name}`],
      source: { type: 'manual' },
      tags: [],
    },
  ])[0];
}

describe('importPersonal', () => {
  let source: Brain;
  let target: Brain;

  beforeEach(() => {
    source = makeBrain();
    target = makeBrain();
  });

  afterEach(() => {
    source.close();
    target.close();
  });

  it('imports all entities and relations into an empty DB', () => {
    const alice = seedPersonalEntity(source, 'Alice');
    const bob = seedPersonalEntity(source, 'Bob');
    source.relations.create({
      type: 'relates_to',
      sourceId: alice.id,
      targetId: bob.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });

    const bundle = exportPersonal(source);
    const result = importPersonal(target, bundle);

    expect(result.entitiesImported).toBe(2);
    expect(result.relationsImported).toBe(1);
    expect(result.droppedDanglingEdges).toBe(0);
    expect(result.conflicts).toEqual([]);

    const targetEntities = target.entities.list({ namespace: 'personal' });
    expect(targetEntities).toHaveLength(2);
    expect(targetEntities.map((e) => e.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('throws on sha256 mismatch', () => {
    seedPersonalEntity(source, 'Alice');
    const bundle = exportPersonal(source);
    const tampered: PersonalBundle = { ...bundle, sha256: 'bad-hash' };

    expect(() => importPersonal(target, tampered)).toThrow(/SHA-256 mismatch/);
  });

  it('upsert: newer entity wins over older', () => {
    // Seed target with an entity
    const existing = seedPersonalEntity(target, 'Alice');
    const existingUpdatedAt = existing.updatedAt;

    // Seed source with same entity name+type, which will have a newer updatedAt
    seedPersonalEntity(source, 'Alice');
    // Update to ensure newer timestamp and different observations
    const sourceEntities = source.entities.findByName('Alice', 'personal');
    source.entities.update(sourceEntities[0].id, {
      observations: ['Updated observation'],
    });

    const bundle = exportPersonal(source);
    const result = importPersonal(target, bundle);

    expect(result.entitiesImported).toBe(1);
    const imported = target.entities.findByName('Alice', 'personal');
    expect(imported).toHaveLength(1);
    // batchUpsert merges observations
    expect(imported[0].observations).toContain('Updated observation');
    // updatedAt should be at least as new as existing
    expect(imported[0].updatedAt >= existingUpdatedAt).toBe(true);
  });

  it('cross-namespace relations with reattach=false are dropped', () => {
    const alice = seedPersonalEntity(source, 'Alice');
    const project = source.entities.batchUpsert([
      {
        type: 'concept',
        name: 'ProjectX',
        namespace: 'proj-123',
        observations: ['A project'],
        source: { type: 'manual' },
        tags: [],
      },
    ])[0];

    source.relations.create({
      type: 'uses',
      sourceId: alice.id,
      targetId: project.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });

    const bundle = exportPersonal(source);
    // Bundle should have the dangling edge (project is not personal)
    expect(bundle.manifest.danglingEntityIds).toContain(project.id);

    const result = importPersonal(target, bundle, { reattach: false });

    expect(result.entitiesImported).toBe(1);
    expect(result.relationsImported).toBe(0);
    expect(result.droppedDanglingEdges).toBe(1);
  });

  it('cross-namespace relations with reattach=true and target exists locally are kept', () => {
    const alice = seedPersonalEntity(source, 'Alice');
    const project = source.entities.batchUpsert([
      {
        type: 'concept',
        name: 'ProjectX',
        namespace: 'proj-123',
        observations: ['A project'],
        source: { type: 'manual' },
        tags: [],
      },
    ])[0];

    source.relations.create({
      type: 'uses',
      sourceId: alice.id,
      targetId: project.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });

    const bundle = exportPersonal(source);

    // Create the same project entity in the target DB with the SAME ID
    // (simulating that the target already has this project-namespace entity)
    target.storage.sqlite
      .prepare(
        `INSERT INTO entities (id, type, name, namespace, observations, properties, confidence,
         event_time, ingest_time, last_accessed_at, access_count, source_type, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        'concept',
        'ProjectX',
        'proj-123',
        JSON.stringify(['A project']),
        JSON.stringify({}),
        1.0,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        0,
        'manual',
        JSON.stringify([]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const result = importPersonal(target, bundle, { reattach: true });

    expect(result.entitiesImported).toBe(1);
    expect(result.relationsImported).toBe(1);
    expect(result.droppedDanglingEdges).toBe(0);
  });

  it('cross-namespace relations with reattach=true but target missing are dropped', () => {
    const alice = seedPersonalEntity(source, 'Alice');
    const project = source.entities.batchUpsert([
      {
        type: 'concept',
        name: 'ProjectX',
        namespace: 'proj-123',
        observations: ['A project'],
        source: { type: 'manual' },
        tags: [],
      },
    ])[0];

    source.relations.create({
      type: 'uses',
      sourceId: alice.id,
      targetId: project.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });

    const bundle = exportPersonal(source);

    // Target DB does NOT have the project entity
    const result = importPersonal(target, bundle, { reattach: true });

    expect(result.entitiesImported).toBe(1);
    expect(result.relationsImported).toBe(0);
    expect(result.droppedDanglingEdges).toBe(1);
  });

  it('returns correct counts', () => {
    const alice = seedPersonalEntity(source, 'Alice');
    const bob = seedPersonalEntity(source, 'Bob');
    const carol = seedPersonalEntity(source, 'Carol');

    source.relations.create({
      type: 'relates_to',
      sourceId: alice.id,
      targetId: bob.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });
    source.relations.create({
      type: 'relates_to',
      sourceId: bob.id,
      targetId: carol.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });

    // Add a cross-namespace relation that will dangle
    const project = source.entities.batchUpsert([
      {
        type: 'concept',
        name: 'ProjectZ',
        namespace: 'proj-999',
        observations: ['Z project'],
        source: { type: 'manual' },
        tags: [],
      },
    ])[0];
    source.relations.create({
      type: 'uses',
      sourceId: alice.id,
      targetId: project.id,
      namespace: 'personal',
      source: { type: 'manual' },
    });

    const bundle = exportPersonal(source);
    const result = importPersonal(target, bundle, { reattach: false });

    expect(result.entitiesImported).toBe(3);
    expect(result.relationsImported).toBe(2);
    expect(result.droppedDanglingEdges).toBe(1);
    expect(result.conflicts).toEqual([]);
  });
});
