import type { Brain } from '../brain.js';
import type { Entity, EntityType, Relation } from '@second-brain/types';
import { rawRowToRelation } from '../temporal/row-mappers.js';
import type { ExportOptions } from './types.js';

const SCHEMA_CONTEXT = {
  '@vocab': 'https://schema.org/',
  brain: 'https://second-brain.dev/schema/',
};

const SCHEMA_TYPE_MAP: Partial<Record<EntityType, string>> = {
  person: 'Person',
  event: 'Event',
};

function entityToNode(entity: Entity): Record<string, unknown> {
  const schemaType = SCHEMA_TYPE_MAP[entity.type];
  return {
    '@id': `urn:brain:entity:${entity.id}`,
    '@type': schemaType ?? `brain:${entity.type}`,
    'brain:name': entity.name,
    'brain:namespace': entity.namespace,
    'brain:observations': entity.observations,
    'brain:properties': entity.properties,
    'brain:confidence': entity.confidence,
    'brain:eventTime': entity.eventTime,
    'brain:source': entity.source,
    'brain:tags': entity.tags,
    'brain:createdAt': entity.createdAt,
    'brain:updatedAt': entity.updatedAt,
  };
}

function relationToEdge(relation: Relation): Record<string, unknown> {
  return {
    '@id': `urn:brain:relation:${relation.id}`,
    '@type': 'brain:Relation',
    'brain:relationType': relation.type,
    'brain:source': `urn:brain:entity:${relation.sourceId}`,
    'brain:target': `urn:brain:entity:${relation.targetId}`,
    'brain:namespace': relation.namespace,
    'brain:properties': relation.properties,
    'brain:confidence': relation.confidence,
    'brain:weight': relation.weight,
    'brain:bidirectional': relation.bidirectional,
    'brain:entitySource': relation.source,
    'brain:eventTime': relation.eventTime,
    'brain:createdAt': relation.createdAt,
    'brain:updatedAt': relation.updatedAt,
  };
}

function collectEntities(brain: Brain, opts: ExportOptions): Entity[] {
  const all: Entity[] = [];
  const limit = 500;
  let offset = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const page = brain.entities.list({ namespace: opts.namespace, limit, offset });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  if (opts.types && opts.types.length > 0) {
    const allowed = new Set(opts.types);
    return all.filter((e) => allowed.has(e.type));
  }
  return all;
}

function collectRelations(brain: Brain, entityIds: Set<string>, namespace?: string): Relation[] {
  const params: unknown[] = [];
  let query = 'SELECT * FROM relations';
  if (namespace !== undefined) {
    query += ' WHERE namespace = ?';
    params.push(namespace);
  }
  const rows = brain.storage.sqlite
    .prepare(query)
    .all(...params) as Record<string, unknown>[];
  return rows
    .map((r) => rawRowToRelation(r))
    .filter((r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId));
}

export function exportJsonLd(brain: Brain, opts: ExportOptions): string {
  const entities = collectEntities(brain, opts);
  const entityIds = new Set(entities.map((e) => e.id));

  const includeRelations = opts.includeRelations !== false;
  const relations = includeRelations ? collectRelations(brain, entityIds, opts.namespace) : [];

  const graph: Record<string, unknown>[] = [
    ...entities.map((e) => entityToNode(e)),
    ...relations.map((r) => relationToEdge(r)),
  ];

  return JSON.stringify({
    '@context': SCHEMA_CONTEXT,
    '@graph': graph,
  });
}
