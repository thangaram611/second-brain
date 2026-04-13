import { z } from 'zod';
import type { Brain } from '../brain.js';
import type {
  Entity,
  CreateEntityInput,
  CreateRelationInput,
  EntityType,
  RelationType,
} from '@second-brain/types';
import { ENTITY_TYPES, RELATION_TYPES } from '@second-brain/types';
import type { ImportOptions, ImportResult, ImportConflict } from './types.js';

const EntitySourceSchema = z.object({
  type: z.enum(['git', 'ast', 'conversation', 'github', 'manual', 'doc', 'inferred']),
  ref: z.string().optional(),
  actor: z.string().optional(),
});

const ImportedEntitySchema = z.object({
  id: z.string(),
  type: z.enum(ENTITY_TYPES),
  name: z.string(),
  namespace: z.string().default('personal'),
  observations: z.array(z.string()).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().default(1.0),
  eventTime: z.string().optional(),
  source: EntitySourceSchema,
  tags: z.array(z.string()).default([]),
});

const ImportedRelationSchema = z.object({
  id: z.string(),
  type: z.enum(RELATION_TYPES),
  sourceId: z.string(),
  targetId: z.string(),
  namespace: z.string().default('personal'),
  properties: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().default(1.0),
  weight: z.number().default(1.0),
  bidirectional: z.boolean().default(false),
  source: EntitySourceSchema,
  eventTime: z.string().optional(),
});

const JsonExportSchema = z.object({
  version: z.string(),
  exportedAt: z.string(),
  entities: z.array(ImportedEntitySchema),
  relations: z.array(ImportedRelationSchema).default([]),
});

const JSONLD_TYPE_REVERSE: Record<string, EntityType> = {
  Person: 'person',
  Event: 'event',
};

function parseJsonLd(
  content: string,
  namespaceOverride?: string,
): { entities: z.infer<typeof ImportedEntitySchema>[]; relations: z.infer<typeof ImportedRelationSchema>[] } {
  const doc = z
    .object({
      '@context': z.unknown(),
      '@graph': z.array(z.record(z.string(), z.unknown())),
    })
    .parse(JSON.parse(content));

  const entities: z.infer<typeof ImportedEntitySchema>[] = [];
  const relations: z.infer<typeof ImportedRelationSchema>[] = [];

  for (const node of doc['@graph']) {
    const nodeType = node['@type'];

    if (nodeType === 'brain:Relation') {
      const sourceUrn = z.string().parse(node['brain:source']);
      const targetUrn = z.string().parse(node['brain:target']);
      const relId = z.string().parse(node['@id']).replace('urn:brain:relation:', '');

      relations.push(
        ImportedRelationSchema.parse({
          id: relId,
          type: z.string().parse(node['brain:relationType']),
          sourceId: sourceUrn.replace('urn:brain:entity:', ''),
          targetId: targetUrn.replace('urn:brain:entity:', ''),
          namespace: namespaceOverride ?? z.string().parse(node['brain:namespace']),
          properties: node['brain:properties'] ?? {},
          confidence: node['brain:confidence'] ?? 1.0,
          weight: node['brain:weight'] ?? 1.0,
          bidirectional: node['brain:bidirectional'] ?? false,
          source: node['brain:entitySource'] ?? { type: 'manual' },
          eventTime: node['brain:eventTime'] as string | undefined,
        }),
      );
    } else {
      const rawId = z.string().parse(node['@id']).replace('urn:brain:entity:', '');
      const rawType = z.string().parse(nodeType);
      const entityType: EntityType =
        JSONLD_TYPE_REVERSE[rawType] ?? (rawType.replace('brain:', '') as EntityType);

      entities.push(
        ImportedEntitySchema.parse({
          id: rawId,
          type: entityType,
          name: z.string().parse(node['brain:name']),
          namespace: namespaceOverride ?? z.string().parse(node['brain:namespace']),
          observations: node['brain:observations'] ?? [],
          properties: node['brain:properties'] ?? {},
          confidence: node['brain:confidence'] ?? 1.0,
          eventTime: node['brain:eventTime'] as string | undefined,
          source: node['brain:source'] ?? { type: 'manual' },
          tags: node['brain:tags'] ?? [],
        }),
      );
    }
  }

  return { entities, relations };
}

function deleteNamespace(brain: Brain, namespace: string): void {
  brain.storage.sqlite.exec(`DELETE FROM relations WHERE namespace = '${namespace.replace(/'/g, "''")}'`);
  brain.storage.sqlite.exec(`DELETE FROM entities WHERE namespace = '${namespace.replace(/'/g, "''")}'`);
}

function buildEntityInput(
  e: z.infer<typeof ImportedEntitySchema>,
  namespaceOverride?: string,
): CreateEntityInput {
  return {
    type: e.type,
    name: e.name,
    namespace: namespaceOverride ?? e.namespace,
    observations: e.observations,
    properties: e.properties,
    confidence: e.confidence,
    eventTime: e.eventTime,
    source: e.source,
    tags: e.tags,
  };
}

export function importGraph(brain: Brain, content: string, opts: ImportOptions): ImportResult {
  let parsedEntities: z.infer<typeof ImportedEntitySchema>[];
  let parsedRelations: z.infer<typeof ImportedRelationSchema>[];

  if (opts.format === 'json-ld') {
    const result = parseJsonLd(content, opts.namespace);
    parsedEntities = result.entities;
    parsedRelations = result.relations;
  } else {
    const parsed = JsonExportSchema.parse(JSON.parse(content));
    parsedEntities = parsed.entities;
    parsedRelations = parsed.relations;
  }

  const conflicts: ImportConflict[] = [];
  const targetNamespace = opts.namespace ?? parsedEntities[0]?.namespace ?? 'personal';

  if (opts.strategy === 'replace') {
    deleteNamespace(brain, targetNamespace);
  }

  // Build name→Entity map for resolving relation targets after import
  const nameTypeToId = new Map<string, string>();
  let entitiesImported = 0;

  if (opts.strategy === 'merge') {
    for (const e of parsedEntities) {
      const ns = opts.namespace ?? e.namespace;
      const existing = brain.entities.findByName(e.name, ns);
      const match = existing.find((ex) => ex.type === e.type);
      if (match) {
        conflicts.push({
          entityName: e.name,
          entityType: e.type,
          existingId: match.id,
          reason: 'Entity with same name and type already exists',
        });
        nameTypeToId.set(`${e.name}::${e.type}`, match.id);
        continue;
      }
      const created = brain.entities.batchUpsert([buildEntityInput(e, opts.namespace)]);
      if (created.length > 0) {
        nameTypeToId.set(`${e.name}::${e.type}`, created[0].id);
        entitiesImported++;
      }
    }
  } else {
    // replace or upsert — both use batchUpsert
    const inputs = parsedEntities.map((e) => buildEntityInput(e, opts.namespace));
    const created = brain.entities.batchUpsert(inputs);
    entitiesImported = created.length;
    for (const c of created) {
      nameTypeToId.set(`${c.name}::${c.type}`, c.id);
    }
  }

  // Build old-id → new-id map using entity names
  const oldIdToNewId = new Map<string, string>();
  for (const e of parsedEntities) {
    const newId = nameTypeToId.get(`${e.name}::${e.type}`);
    if (newId) {
      oldIdToNewId.set(e.id, newId);
    }
  }

  // Import relations with remapped IDs
  let relationsImported = 0;
  if (parsedRelations.length > 0) {
    const relationInputs: CreateRelationInput[] = [];
    for (const r of parsedRelations) {
      const newSourceId = oldIdToNewId.get(r.sourceId);
      const newTargetId = oldIdToNewId.get(r.targetId);
      if (!newSourceId || !newTargetId) continue;

      relationInputs.push({
        type: r.type,
        sourceId: newSourceId,
        targetId: newTargetId,
        namespace: opts.namespace ?? r.namespace,
        properties: r.properties,
        confidence: r.confidence,
        weight: r.weight,
        bidirectional: r.bidirectional,
        source: r.source,
        eventTime: r.eventTime,
      });
    }

    if (relationInputs.length > 0) {
      const created = brain.relations.batchUpsert(relationInputs);
      relationsImported = created.length;
    }
  }

  return { entitiesImported, relationsImported, conflicts };
}
