import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Brain } from '../brain.js';
import type { Entity, Relation } from '@second-brain/types';
import { rawRowToRelation } from '../temporal/row-mappers.js';
import type { PersonalBundle } from './types.js';

function collectPersonalEntities(brain: Brain): Entity[] {
  const all: Entity[] = [];
  const limit = 500;
  let offset = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const page = brain.entities.list({ namespace: 'personal', limit, offset });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

function collectPersonalRelations(brain: Brain): Relation[] {
  const rows = brain.storage.sqlite
    .prepare('SELECT * FROM relations WHERE namespace = ?')
    .all('personal') as Record<string, unknown>[];
  return rows.map((r) => rawRowToRelation(r));
}

export function exportPersonal(brain: Brain): PersonalBundle {
  const entities = collectPersonalEntities(brain);
  const relations = collectPersonalRelations(brain);

  const entityIds = new Set(entities.map((e) => e.id));
  const danglingSet = new Set<string>();
  for (const r of relations) {
    if (!entityIds.has(r.sourceId)) danglingSet.add(r.sourceId);
    if (!entityIds.has(r.targetId)) danglingSet.add(r.targetId);
  }

  const hashContent = JSON.stringify(entities) + JSON.stringify(relations);
  const sha256 = createHash('sha256').update(hashContent).digest('hex');

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    entities,
    relations,
    manifest: {
      danglingEntityIds: [...danglingSet],
      sourceHostname: hostname(),
      schemaVersion: 1,
    },
    sha256,
  };
}
