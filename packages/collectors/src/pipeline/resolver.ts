import type { Brain } from '@second-brain/core';
import type { CreateRelationInput, Entity } from '@second-brain/types';
import { RELATION_TYPES } from '@second-brain/types';
import type { PendingRelation } from '@second-brain/ingestion';

function isValidRelationType(value: string): value is CreateRelationInput['type'] {
  return (RELATION_TYPES as ReadonlyArray<string>).includes(value);
}

export interface ResolveResult {
  resolved: CreateRelationInput[];
  skipped: number;
}

/**
 * Resolves PendingRelations (name-based) into CreateRelationInputs (ID-based)
 * by looking up entities in the brain.
 */
export function resolveRelations(
  brain: Brain,
  pending: ReadonlyArray<PendingRelation>,
  namespace: string,
): ResolveResult {
  const resolved: CreateRelationInput[] = [];
  let skipped = 0;

  // Build a cache to avoid repeated DB lookups for the same name+type
  const entityCache = new Map<string, Entity | null>();

  function lookupEntity(name: string, type: string, ns: string): Entity | null {
    const key = `${type}:${ns}:${name}`;
    if (entityCache.has(key)) {
      return entityCache.get(key)!;
    }
    const matches = brain.entities.findByName(name, ns);
    const match = matches.find((e) => e.type === type && e.name === name) ?? null;
    entityCache.set(key, match);
    return match;
  }

  for (const rel of pending) {
    if (!isValidRelationType(rel.type)) {
      skipped++;
      continue;
    }

    const ns = rel.namespace ?? namespace;
    const source = lookupEntity(rel.sourceName, rel.sourceType, ns);
    const target = lookupEntity(rel.targetName, rel.targetType, ns);

    if (!source || !target) {
      skipped++;
      continue;
    }

    resolved.push({
      type: rel.type,
      sourceId: source.id,
      targetId: target.id,
      namespace: ns,
      properties: rel.properties,
      confidence: rel.confidence,
      weight: rel.weight,
      bidirectional: rel.bidirectional,
      source: rel.source,
      eventTime: rel.eventTime,
    });
  }

  return { resolved, skipped };
}
