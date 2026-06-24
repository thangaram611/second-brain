import type { Brain } from '../brain.js';
import type { Entity, EntityType, Relation } from '@second-brain/types';
import { rawRowToRelation } from '../temporal/row-mappers.js';

export function collectEntities(
  brain: Brain,
  opts: { namespace?: string; types?: EntityType[] },
): Entity[] {
  const all: Entity[] = [];
  const limit = 500;
  let offset = 0;
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

export function collectRelations(
  brain: Brain,
  entityIds: Set<string>,
  opts?: { namespace?: string; dropDangling?: boolean },
): Relation[] {
  const params: unknown[] = [];
  let query = 'SELECT * FROM relations';
  if (opts?.namespace !== undefined) {
    query += ' WHERE namespace = ?';
    params.push(opts.namespace);
  }
  const rows = brain.storage.sqlite.prepare(query).all(...params);
  const mapped = rows.map((r) => rawRowToRelation(r));
  if (opts?.dropDangling === false) {
    return mapped;
  }
  return mapped.filter((r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId));
}
