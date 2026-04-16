import * as Y from 'yjs';
import type { Entity, Relation, SyncConflict, CreateEntityInput, CreateRelationInput } from '@second-brain/types';
import type { EntityManager, RelationManager } from '@second-brain/core';
import { entityToYMap, relationToYMap, yMapToEntity, yMapToRelation } from './schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Y.js observeDeep signature exactly
type DeepObserverFn = (events: Array<Y.YEvent<any>>, txn: Y.Transaction) => void;

/**
 * Creates a deep observer that filters by origin, collects affected/deleted IDs,
 * and delegates to caller-provided handlers.
 */
function createDeepObserver(
  rootMap: Y.Map<unknown>,
  handlers: {
    onDelete: (id: string) => void;
    onUpsert: (id: string, yMap: Y.Map<unknown>) => void;
  },
): DeepObserverFn {
  return (events, txn) => {
    if (txn.origin === SyncBridge.LOCAL_ORIGIN || txn.origin === 'hydrate') return;

    const affectedIds = new Set<string>();
    const deletedIds = new Set<string>();

    for (const event of events) {
      if (event.target === rootMap) {
        for (const [key, change] of event.changes.keys) {
          if (change.action === 'delete') {
            deletedIds.add(key);
          } else {
            affectedIds.add(key);
          }
        }
      } else {
        const path = event.path;
        if (path.length > 0) {
          const id = path[0];
          if (typeof id === 'string') {
            affectedIds.add(id);
          }
        }
      }
    }

    for (const id of deletedIds) {
      handlers.onDelete(id);
    }

    for (const id of affectedIds) {
      const yMap = rootMap.get(id);
      if (!(yMap instanceof Y.Map)) continue;
      handlers.onUpsert(id, yMap);
    }
  };
}

/**
 * Bidirectional bridge between a Y.Doc and SQLite storage.
 *
 * Uses `observeDeep` on the entities/relations maps so that both
 * top-level key changes (entity add/delete) and nested field changes
 * (name update, confidence change, etc.) are captured.
 */
export class SyncBridge {
  static readonly LOCAL_ORIGIN = 'local';

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

    this.entityDeepObserver = createDeepObserver(entitiesMap, {
      onDelete: (id) => this.entityManager.delete(id),
      onUpsert: (id, yMap) => {
        let remoteEntity: Entity;
        try {
          remoteEntity = yMapToEntity(yMap);
        } catch {
          return;
        }

        if (this.onConflict) {
          const existing = this.entityManager.get(id);
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
      },
    });

    this.relationDeepObserver = createDeepObserver(relationsMap, {
      onDelete: (id) => this.relationManager.delete(id),
      onUpsert: (_id, yMap) => {
        let remoteRelation: Relation;
        try {
          remoteRelation = yMapToRelation(yMap);
        } catch {
          return;
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
      },
    });

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
