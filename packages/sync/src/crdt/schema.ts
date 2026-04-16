import * as Y from 'yjs';
import type { Entity, Relation, EntitySource } from '@second-brain/types';
import { isEntityType, isRelationType, isSourceType } from '@second-brain/types';

// ---- Safe extraction helpers (NO `as` casts) ----

function getString(map: Y.Map<unknown>, key: string): string {
  const val = map.get(key);
  if (typeof val !== 'string') throw new Error(`Expected string for "${key}", got ${typeof val}`);
  return val;
}

function getNumber(map: Y.Map<unknown>, key: string): number {
  const val = map.get(key);
  if (typeof val !== 'number') throw new Error(`Expected number for "${key}", got ${typeof val}`);
  return val;
}

function getBoolean(map: Y.Map<unknown>, key: string): boolean {
  const val = map.get(key);
  if (typeof val !== 'boolean') throw new Error(`Expected boolean for "${key}", got ${typeof val}`);
  return val;
}

function getOptionalString(map: Y.Map<unknown>, key: string): string | undefined {
  const val = map.get(key);
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new Error(`Expected string or undefined for "${key}", got ${typeof val}`);
  return val;
}

// ---- Y.Doc factory ----

export function createBrainDoc(): Y.Doc {
  const doc = new Y.Doc();
  // Access maps to initialize them
  doc.getMap('entities');
  doc.getMap('relations');
  const meta = doc.getMap('meta');
  meta.set('version', 1);
  meta.set('lastModified', new Date().toISOString());
  return doc;
}

// ---- Entity <-> Y.Map ----

export function entityToYMap(doc: Y.Doc, entity: Entity): void {
  const entitiesMap = doc.getMap('entities');

  const entityMap = new Y.Map<unknown>();
  entityMap.set('id', entity.id);
  entityMap.set('type', entity.type);
  entityMap.set('name', entity.name);
  entityMap.set('namespace', entity.namespace);

  // observations as Y.Map set pattern
  const obsMap = new Y.Map<unknown>();
  for (const obs of entity.observations) {
    obsMap.set(obs, true);
  }
  entityMap.set('observations', obsMap);

  // properties as Y.Map
  const propsMap = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(entity.properties)) {
    propsMap.set(k, v);
  }
  entityMap.set('properties', propsMap);

  entityMap.set('confidence', entity.confidence);
  entityMap.set('eventTime', entity.eventTime);
  entityMap.set('ingestTime', entity.ingestTime);
  entityMap.set('lastAccessedAt', entity.lastAccessedAt);
  entityMap.set('accessCount', entity.accessCount);

  // source fields flattened
  entityMap.set('sourceType', entity.source.type);
  if (entity.source.ref !== undefined) {
    entityMap.set('sourceRef', entity.source.ref);
  }
  if (entity.source.actor !== undefined) {
    entityMap.set('sourceActor', entity.source.actor);
  }

  // tags as Y.Map set pattern
  const tagsMap = new Y.Map<unknown>();
  for (const tag of entity.tags) {
    tagsMap.set(tag, true);
  }
  entityMap.set('tags', tagsMap);

  entityMap.set('createdAt', entity.createdAt);
  entityMap.set('updatedAt', entity.updatedAt);

  entitiesMap.set(entity.id, entityMap);
}

export function yMapToEntity(yMap: Y.Map<unknown>): Entity {
  const id = getString(yMap, 'id');
  const typeVal = getString(yMap, 'type');
  if (!isEntityType(typeVal)) {
    throw new Error(`Invalid entity type: "${typeVal}"`);
  }

  const sourceTypeVal = getString(yMap, 'sourceType');
  if (!isSourceType(sourceTypeVal)) {
    throw new Error(`Invalid source type: "${sourceTypeVal}"`);
  }

  const source: EntitySource = {
    type: sourceTypeVal,
    ref: getOptionalString(yMap, 'sourceRef'),
    actor: getOptionalString(yMap, 'sourceActor'),
  };

  return {
    id,
    type: typeVal,
    name: getString(yMap, 'name'),
    namespace: getString(yMap, 'namespace'),
    observations: getObservations(yMap),
    properties: getPropertiesRecord(yMap),
    confidence: getNumber(yMap, 'confidence'),
    eventTime: getString(yMap, 'eventTime'),
    ingestTime: getString(yMap, 'ingestTime'),
    lastAccessedAt: getString(yMap, 'lastAccessedAt'),
    accessCount: getNumber(yMap, 'accessCount'),
    source,
    tags: getTags(yMap),
    createdAt: getString(yMap, 'createdAt'),
    updatedAt: getString(yMap, 'updatedAt'),
  };
}

// ---- Relation <-> Y.Map ----

export function relationToYMap(doc: Y.Doc, relation: Relation): void {
  const relationsMap = doc.getMap('relations');

  const relMap = new Y.Map<unknown>();
  relMap.set('id', relation.id);
  relMap.set('type', relation.type);
  relMap.set('sourceId', relation.sourceId);
  relMap.set('targetId', relation.targetId);
  relMap.set('namespace', relation.namespace);

  const propsMap = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(relation.properties)) {
    propsMap.set(k, v);
  }
  relMap.set('properties', propsMap);

  relMap.set('confidence', relation.confidence);
  relMap.set('weight', relation.weight);
  relMap.set('bidirectional', relation.bidirectional);

  relMap.set('sourceType', relation.source.type);
  if (relation.source.ref !== undefined) {
    relMap.set('sourceRef', relation.source.ref);
  }
  if (relation.source.actor !== undefined) {
    relMap.set('sourceActor', relation.source.actor);
  }

  relMap.set('eventTime', relation.eventTime);
  relMap.set('ingestTime', relation.ingestTime);
  relMap.set('createdAt', relation.createdAt);
  relMap.set('updatedAt', relation.updatedAt);

  relationsMap.set(relation.id, relMap);
}

export function yMapToRelation(yMap: Y.Map<unknown>): Relation {
  const id = getString(yMap, 'id');
  const typeVal = getString(yMap, 'type');
  if (!isRelationType(typeVal)) {
    throw new Error(`Invalid relation type: "${typeVal}"`);
  }

  const sourceTypeVal = getString(yMap, 'sourceType');
  if (!isSourceType(sourceTypeVal)) {
    throw new Error(`Invalid source type: "${sourceTypeVal}"`);
  }

  const source: EntitySource = {
    type: sourceTypeVal,
    ref: getOptionalString(yMap, 'sourceRef'),
    actor: getOptionalString(yMap, 'sourceActor'),
  };

  return {
    id,
    type: typeVal,
    sourceId: getString(yMap, 'sourceId'),
    targetId: getString(yMap, 'targetId'),
    namespace: getString(yMap, 'namespace'),
    properties: getPropertiesRecord(yMap),
    confidence: getNumber(yMap, 'confidence'),
    weight: getNumber(yMap, 'weight'),
    bidirectional: getBoolean(yMap, 'bidirectional'),
    source,
    eventTime: getString(yMap, 'eventTime'),
    ingestTime: getString(yMap, 'ingestTime'),
    createdAt: getString(yMap, 'createdAt'),
    updatedAt: getString(yMap, 'updatedAt'),
  };
}

// ---- Observation helpers (set pattern) ----

export function setObservations(entityYMap: Y.Map<unknown>, observations: string[]): void {
  const obsMap = getOrCreateNestedMap(entityYMap, 'observations');
  // Clear existing keys
  for (const key of Array.from(obsMap.keys())) {
    obsMap.delete(key);
  }
  for (const obs of observations) {
    obsMap.set(obs, true);
  }
}

export function getObservations(entityYMap: Y.Map<unknown>): string[] {
  const obsMap = entityYMap.get('observations');
  if (!(obsMap instanceof Y.Map)) return [];
  return Array.from(obsMap.keys());
}

// ---- Tag helpers (set pattern) ----

export function setTags(entityYMap: Y.Map<unknown>, tags: string[]): void {
  const tagsMap = getOrCreateNestedMap(entityYMap, 'tags');
  // Clear existing keys
  for (const key of Array.from(tagsMap.keys())) {
    tagsMap.delete(key);
  }
  for (const tag of tags) {
    tagsMap.set(tag, true);
  }
}

export function getTags(entityYMap: Y.Map<unknown>): string[] {
  const tagsMap = entityYMap.get('tags');
  if (!(tagsMap instanceof Y.Map)) return [];
  return Array.from(tagsMap.keys());
}

// ---- Private helpers ----

function getOrCreateNestedMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const existing = parent.get(key);
  if (existing instanceof Y.Map) {
    return existing;
  }
  const created = new Y.Map<unknown>();
  parent.set(key, created);
  return created;
}

function getPropertiesRecord(yMap: Y.Map<unknown>): Record<string, unknown> {
  const propsMap = yMap.get('properties');
  if (!(propsMap instanceof Y.Map)) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of propsMap.entries()) {
    result[k] = v;
  }
  return result;
}
