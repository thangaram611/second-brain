import type { Brain } from '../brain.js';
import type { Entity, Relation } from '@second-brain/types';
import { rawRowToRelation } from '../temporal/row-mappers.js';
import type { ExportOptions } from './types.js';

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

export function exportJson(brain: Brain, opts: ExportOptions): string {
  const entities = collectEntities(brain, opts);
  const entityIds = new Set(entities.map((e) => e.id));

  const includeRelations = opts.includeRelations !== false;
  const relations = includeRelations ? collectRelations(brain, entityIds, opts.namespace) : [];

  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    entities,
    relations,
  });
}
