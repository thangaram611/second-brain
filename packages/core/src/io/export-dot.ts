import type { Brain } from '../brain.js';
import type { Entity, EntityType, Relation } from '@second-brain/types';
import { rawRowToRelation } from '../temporal/row-mappers.js';
import type { ExportOptions } from './types.js';

const SHAPE_MAP: Partial<Record<EntityType, string>> = {
  file: 'box',
  concept: 'ellipse',
  decision: 'diamond',
  person: 'octagon',
  event: 'parallelogram',
};

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function nodeShape(type: EntityType): string {
  return SHAPE_MAP[type] ?? 'ellipse';
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

export function exportDot(brain: Brain, opts: ExportOptions): string {
  const entities = collectEntities(brain, opts);
  const entityIds = new Set(entities.map((e) => e.id));

  const includeRelations = opts.includeRelations !== false;
  const relations = includeRelations ? collectRelations(brain, entityIds, opts.namespace) : [];

  const lines: string[] = ['digraph brain {', '  rankdir=LR;'];

  for (const entity of entities) {
    const label = escapeLabel(entity.name);
    const shape = nodeShape(entity.type);
    lines.push(`  "${entity.id}" [label="${label}" shape=${shape}];`);
  }

  for (const rel of relations) {
    const label = escapeLabel(rel.type);
    lines.push(`  "${rel.sourceId}" -> "${rel.targetId}" [label="${label}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}
