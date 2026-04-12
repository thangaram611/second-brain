import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Brain } from '@second-brain/core';
import type { Entity, Relation, SyncConflict, CreateEntityInput, CreateRelationInput } from '@second-brain/types';
import { createBrainDoc, yMapToEntity, yMapToRelation } from '../crdt/schema.js';
import { hydrateDocFromDatabase } from '../crdt/hydrate.js';
import { SyncBridge } from '../crdt/bridge.js';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function makeEntityInput(name: string, namespace = 'team-a'): CreateEntityInput {
  return {
    type: 'concept',
    name,
    namespace,
    observations: [`${name} is important`],
    properties: { key: 'value' },
    source: { type: 'manual' },
    tags: ['test'],
  };
}

function makeRelationInput(sourceId: string, targetId: string, namespace = 'team-a'): CreateRelationInput {
  return {
    type: 'relates_to',
    sourceId,
    targetId,
    namespace,
    source: { type: 'manual' },
  };
}

describe('hydrateDocFromDatabase', () => {
  it('hydrates entities from SQLite into a Y.Doc', () => {
    const e1 = brain.entities.create(makeEntityInput('Entity A'));
    const e2 = brain.entities.create(makeEntityInput('Entity B'));

    const doc = createBrainDoc();
    hydrateDocFromDatabase(doc, brain.entities, brain.relations, 'team-a');

    const entitiesMap = doc.getMap('entities');
    expect(entitiesMap.size).toBe(2);

    const yMap1 = entitiesMap.get(e1.id);
    expect(yMap1).toBeInstanceOf(Y.Map);
    if (yMap1 instanceof Y.Map) {
      const entity = yMapToEntity(yMap1);
      expect(entity.name).toBe('Entity A');
    }

    doc.destroy();
  });

  it('hydrates relations from SQLite into a Y.Doc', () => {
    const e1 = brain.entities.create(makeEntityInput('Src'));
    const e2 = brain.entities.create(makeEntityInput('Tgt'));
    brain.relations.create(makeRelationInput(e1.id, e2.id));

    const doc = createBrainDoc();
    hydrateDocFromDatabase(doc, brain.entities, brain.relations, 'team-a');

    expect(doc.getMap('relations').size).toBe(1);

    doc.destroy();
  });

  it('ignores entities from other namespaces', () => {
    brain.entities.create(makeEntityInput('Entity A', 'team-a'));
    brain.entities.create(makeEntityInput('Entity B', 'team-b'));

    const doc = createBrainDoc();
    hydrateDocFromDatabase(doc, brain.entities, brain.relations, 'team-a');

    expect(doc.getMap('entities').size).toBe(1);

    doc.destroy();
  });

  it('deduplicates relations collected across entities', () => {
    const e1 = brain.entities.create(makeEntityInput('E1'));
    const e2 = brain.entities.create(makeEntityInput('E2'));
    // Only one relation between them
    brain.relations.create(makeRelationInput(e1.id, e2.id));

    const doc = createBrainDoc();
    hydrateDocFromDatabase(doc, brain.entities, brain.relations, 'team-a');

    // Even though we iterate both e1 and e2, relation should appear once
    expect(doc.getMap('relations').size).toBe(1);

    doc.destroy();
  });
});

describe('SyncBridge', () => {
  describe('pushEntityToDoc / pushRelationToDoc', () => {
    it('pushes a local entity to Y.Doc', () => {
      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      const entity = brain.entities.create(makeEntityInput('Pushed'));
      bridge.pushEntityToDoc(entity);

      const yMap = doc.getMap('entities').get(entity.id);
      expect(yMap).toBeInstanceOf(Y.Map);
      if (yMap instanceof Y.Map) {
        const result = yMapToEntity(yMap);
        expect(result.name).toBe('Pushed');
      }

      doc.destroy();
    });

    it('pushes a local relation to Y.Doc', () => {
      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      const e1 = brain.entities.create(makeEntityInput('Src'));
      const e2 = brain.entities.create(makeEntityInput('Tgt'));
      const rel = brain.relations.create(makeRelationInput(e1.id, e2.id));
      bridge.pushRelationToDoc(rel);

      const yMap = doc.getMap('relations').get(rel.id);
      expect(yMap).toBeInstanceOf(Y.Map);
      if (yMap instanceof Y.Map) {
        const result = yMapToRelation(yMap);
        expect(result.sourceId).toBe(e1.id);
        expect(result.targetId).toBe(e2.id);
      }

      doc.destroy();
    });
  });

  describe('deleteEntityFromDoc / deleteRelationFromDoc', () => {
    it('deletes an entity from Y.Doc', () => {
      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      const entity = brain.entities.create(makeEntityInput('ToDelete'));
      bridge.pushEntityToDoc(entity);
      expect(doc.getMap('entities').has(entity.id)).toBe(true);

      bridge.deleteEntityFromDoc(entity.id);
      expect(doc.getMap('entities').has(entity.id)).toBe(false);

      doc.destroy();
    });
  });

  describe('observer: remote changes -> SQLite', () => {
    it('does NOT process local-origin changes', () => {
      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      bridge.startObserving();

      // Push via bridge (local origin) — should NOT create a duplicate in SQLite
      const entity = brain.entities.create(makeEntityInput('LocalOnly'));
      bridge.pushEntityToDoc(entity);

      // The entity already existed in SQLite, the observer should NOT have tried to batchUpsert
      // (because transaction origin === 'local')
      // We verify by checking there's still exactly 1 entity with that name
      const found = brain.entities.findByName('LocalOnly', 'team-a');
      expect(found).toHaveLength(1);

      bridge.stopObserving();
      doc.destroy();
    });

    it('does NOT process hydrate-origin changes', () => {
      const entity = brain.entities.create(makeEntityInput('Hydrated'));

      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      bridge.startObserving();

      // Hydrate — origin is 'hydrate', observer should skip
      hydrateDocFromDatabase(doc, brain.entities, brain.relations, 'team-a');

      // Still just 1 entity
      const found = brain.entities.findByName('Hydrated', 'team-a');
      expect(found).toHaveLength(1);

      bridge.stopObserving();
      doc.destroy();
    });

    it('processes remote-origin changes and upserts to SQLite', () => {
      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      bridge.startObserving();

      // Simulate a remote change (origin !== 'local' and !== 'hydrate')
      doc.transact(() => {
        const entitiesMap = doc.getMap('entities');
        const entityMap = new Y.Map<unknown>();
        entityMap.set('id', 'remote-001');
        entityMap.set('type', 'concept');
        entityMap.set('name', 'RemoteEntity');
        entityMap.set('namespace', 'team-a');

        const obsMap = new Y.Map<unknown>();
        obsMap.set('Remote observation', true);
        entityMap.set('observations', obsMap);

        const propsMap = new Y.Map<unknown>();
        entityMap.set('properties', propsMap);

        entityMap.set('confidence', 0.8);
        entityMap.set('eventTime', '2025-03-01T00:00:00.000Z');
        entityMap.set('ingestTime', '2025-03-01T00:00:01.000Z');
        entityMap.set('lastAccessedAt', '2025-03-01T00:00:00.000Z');
        entityMap.set('accessCount', 0);
        entityMap.set('sourceType', 'manual');
        entityMap.set('createdAt', '2025-03-01T00:00:00.000Z');
        entityMap.set('updatedAt', '2025-03-01T00:00:00.000Z');

        const tagsMap = new Y.Map<unknown>();
        entityMap.set('tags', tagsMap);

        entitiesMap.set('remote-001', entityMap);
      }, 'remote-peer');

      // The observer should have upserted into SQLite
      const found = brain.entities.findByName('RemoteEntity', 'team-a');
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found[0].name).toBe('RemoteEntity');

      bridge.stopObserving();
      doc.destroy();
    });

    it('deletes entity from SQLite on remote delete', () => {
      const entity = brain.entities.create(makeEntityInput('WillBeDeleted'));

      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      // First push entity so it exists in Y.Doc
      bridge.pushEntityToDoc(entity);
      bridge.startObserving();

      // Simulate remote delete
      doc.transact(() => {
        doc.getMap('entities').delete(entity.id);
      }, 'remote-peer');

      // Entity should be deleted from SQLite
      expect(brain.entities.get(entity.id)).toBeNull();

      bridge.stopObserving();
      doc.destroy();
    });
  });

  describe('conflict detection', () => {
    it('calls onConflict when remote update has different name', () => {
      const conflicts: SyncConflict[] = [];

      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
        onConflict: (conflict) => conflicts.push(conflict),
      });

      // Create local entity and push to doc
      const entity = brain.entities.create(makeEntityInput('OriginalName'));
      bridge.pushEntityToDoc(entity);
      bridge.startObserving();

      // Simulate remote updating the same entity with a different name
      doc.transact(() => {
        const yMap = doc.getMap('entities').get(entity.id);
        if (yMap instanceof Y.Map) {
          yMap.set('name', 'RenamedByRemote');
        }
      }, 'remote-peer');

      expect(conflicts.length).toBeGreaterThanOrEqual(1);
      const nameConflict = conflicts.find((c) => c.field === 'name');
      expect(nameConflict).toBeDefined();
      expect(nameConflict?.localValue).toBe('OriginalName');
      expect(nameConflict?.remoteValue).toBe('RenamedByRemote');

      bridge.stopObserving();
      doc.destroy();
    });
  });

  describe('stopObserving', () => {
    it('stops processing remote changes after stopObserving', () => {
      const doc = createBrainDoc();
      const bridge = new SyncBridge({
        doc,
        entityManager: brain.entities,
        relationManager: brain.relations,
        namespace: 'team-a',
      });

      bridge.startObserving();
      bridge.stopObserving();

      // Simulate a remote change after stopping
      doc.transact(() => {
        const entitiesMap = doc.getMap('entities');
        const entityMap = new Y.Map<unknown>();
        entityMap.set('id', 'after-stop');
        entityMap.set('type', 'concept');
        entityMap.set('name', 'AfterStop');
        entityMap.set('namespace', 'team-a');
        entityMap.set('observations', new Y.Map<unknown>());
        entityMap.set('properties', new Y.Map<unknown>());
        entityMap.set('confidence', 1.0);
        entityMap.set('eventTime', '2025-01-01T00:00:00.000Z');
        entityMap.set('ingestTime', '2025-01-01T00:00:00.000Z');
        entityMap.set('lastAccessedAt', '2025-01-01T00:00:00.000Z');
        entityMap.set('accessCount', 0);
        entityMap.set('sourceType', 'manual');
        entityMap.set('createdAt', '2025-01-01T00:00:00.000Z');
        entityMap.set('updatedAt', '2025-01-01T00:00:00.000Z');
        entityMap.set('tags', new Y.Map<unknown>());
        entitiesMap.set('after-stop', entityMap);
      }, 'remote-peer');

      // Should NOT have been upserted
      const found = brain.entities.findByName('AfterStop', 'team-a');
      expect(found).toHaveLength(0);

      doc.destroy();
    });
  });
});
