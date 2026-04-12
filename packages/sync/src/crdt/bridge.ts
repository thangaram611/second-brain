import * as Y from 'yjs';
import type { Entity, Relation, SyncConflict, CreateEntityInput, CreateRelationInput } from '@second-brain/types';
import type { EntityManager, RelationManager } from '@second-brain/core';
import { entityToYMap, relationToYMap, yMapToEntity, yMapToRelation } from './schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Y.js observeDeep signature exactly
type DeepObserverFn = (events: Array<Y.YEvent<any>>, txn: Y.Transaction) => void;

/**
 * Bidirectional bridge between a Y.Doc and SQLite storage.
 *
 * Uses `observeDeep` on the entities/relations maps so that both
 * top-level key changes (entity add/delete) and nested field changes
 * (name update, confidence change, etc.) are captured.
 */
export class SyncBridge {
  private static LOCAL_ORIGIN = 'local';

  private doc: Y.Doc;
  private entityManager: EntityManager;
  private relationManager: RelationManager;
  private namespace: string;
  private entityDeepObserver: DeepObserverFn | null = null;
  private relationDeepObserver: DeepObserverFn | null = null;
  private onConflict?: (conflict: SyncConflict) => void;

  constructor(params: {
    doc: Y.Doc;
    entityManager: EntityManager;
    relationManager: RelationManager;
    namespace: string;
    onConflict?: (conflict: SyncConflict) => void;
  }) {
    this.doc = params.doc;
    this.entityManager = params.entityManager;
    this.relationManager = params.relationManager;
    this.namespace = params.namespace;
    this.onConflict = params.onConflict;
  }

  startObserving(): void {
    const entitiesMap = this.doc.getMap('entities');
    const relationsMap = this.doc.getMap('relations');

    this.entityDeepObserver = (events, txn) => {
      if (txn.origin === SyncBridge.LOCAL_ORIGIN || txn.origin === 'hydrate') return;

      const affectedEntityIds = new Set<string>();
      const deletedEntityIds = new Set<string>();

      for (const event of events) {
        if (event.target === entitiesMap) {
          // Top-level changes on the entities map
          for (const [key, change] of event.changes.keys) {
            if (change.action === 'delete') {
              deletedEntityIds.add(key);
            } else {
              affectedEntityIds.add(key);
            }
          }
        } else {
          // Nested change: event.path gives the path from the observed target (entitiesMap)
          // to the event target. The first path element is the entity ID.
          const path = event.path;
          if (path.length > 0) {
            const entityId = path[0];
            if (typeof entityId === 'string') {
              affectedEntityIds.add(entityId);
            }
          }
        }
      }

      for (const entityId of deletedEntityIds) {
        this.entityManager.delete(entityId);
      }

      for (const entityId of affectedEntityIds) {
        const yMap = entitiesMap.get(entityId);
        if (!(yMap instanceof Y.Map)) continue;

        let remoteEntity: Entity;
        try {
          remoteEntity = yMapToEntity(yMap);
        } catch {
          continue;
        }

        if (this.onConflict) {
          const existing = this.entityManager.get(entityId);
          if (existing) {
            this.detectEntityConflicts(existing, remoteEntity);
          }
        }

        const input: CreateEntityInput = {
          type: remoteEntity.type,
          name: remoteEntity.name,
          namespace: remoteEntity.namespace,
          observations: remoteEntity.observations,
          properties: remoteEntity.properties,
          confidence: remoteEntity.confidence,
          eventTime: remoteEntity.eventTime,
          source: remoteEntity.source,
          tags: remoteEntity.tags,
        };
        this.entityManager.batchUpsert([input]);
      }
    };

    this.relationDeepObserver = (events, txn) => {
      if (txn.origin === SyncBridge.LOCAL_ORIGIN || txn.origin === 'hydrate') return;

      const affectedRelationIds = new Set<string>();
      const deletedRelationIds = new Set<string>();

      for (const event of events) {
        if (event.target === relationsMap) {
          for (const [key, change] of event.changes.keys) {
            if (change.action === 'delete') {
              deletedRelationIds.add(key);
            } else {
              affectedRelationIds.add(key);
            }
          }
        } else {
          const path = event.path;
          if (path.length > 0) {
            const relationId = path[0];
            if (typeof relationId === 'string') {
              affectedRelationIds.add(relationId);
            }
          }
        }
      }

      for (const relationId of deletedRelationIds) {
        this.relationManager.delete(relationId);
      }

      for (const relationId of affectedRelationIds) {
        const yMap = relationsMap.get(relationId);
        if (!(yMap instanceof Y.Map)) continue;

        let remoteRelation: Relation;
        try {
          remoteRelation = yMapToRelation(yMap);
        } catch {
          continue;
        }

        const input: CreateRelationInput = {
          type: remoteRelation.type,
          sourceId: remoteRelation.sourceId,
          targetId: remoteRelation.targetId,
          namespace: remoteRelation.namespace,
          properties: remoteRelation.properties,
          confidence: remoteRelation.confidence,
          weight: remoteRelation.weight,
          bidirectional: remoteRelation.bidirectional,
          source: remoteRelation.source,
          eventTime: remoteRelation.eventTime,
        };
        this.relationManager.batchUpsert([input]);
      }
    };

    entitiesMap.observeDeep(this.entityDeepObserver);
    relationsMap.observeDeep(this.relationDeepObserver);
  }

  stopObserving(): void {
    if (this.entityDeepObserver) {
      this.doc.getMap('entities').unobserveDeep(this.entityDeepObserver);
      this.entityDeepObserver = null;
    }
    if (this.relationDeepObserver) {
      this.doc.getMap('relations').unobserveDeep(this.relationDeepObserver);
      this.relationDeepObserver = null;
    }
  }

  pushEntityToDoc(entity: Entity): void {
    this.doc.transact(() => {
      entityToYMap(this.doc, entity);
    }, SyncBridge.LOCAL_ORIGIN);
  }

  pushRelationToDoc(relation: Relation): void {
    this.doc.transact(() => {
      relationToYMap(this.doc, relation);
    }, SyncBridge.LOCAL_ORIGIN);
  }

  deleteEntityFromDoc(entityId: string): void {
    this.doc.transact(() => {
      this.doc.getMap('entities').delete(entityId);
    }, SyncBridge.LOCAL_ORIGIN);
  }

  deleteRelationFromDoc(relationId: string): void {
    this.doc.transact(() => {
      this.doc.getMap('relations').delete(relationId);
    }, SyncBridge.LOCAL_ORIGIN);
  }

  // ---- Private ----

  private detectEntityConflicts(local: Entity, remote: Entity): void {
    if (!this.onConflict) return;

    if (local.name !== remote.name) {
      this.onConflict({
        entityId: remote.id,
        entityName: remote.name,
        field: 'name',
        localValue: local.name,
        remoteValue: remote.name,
        resolvedAt: null,
      });
    }

    if (local.confidence !== remote.confidence) {
      this.onConflict({
        entityId: remote.id,
        entityName: remote.name,
        field: 'confidence',
        localValue: local.confidence,
        remoteValue: remote.confidence,
        resolvedAt: null,
      });
    }
  }
}
