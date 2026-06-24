import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Brain } from '../brain.js';
import { collectEntities, collectRelations } from './collect.js';
import type { PersonalBundle } from './types.js';

export function exportPersonal(brain: Brain): PersonalBundle {
  const entities = collectEntities(brain, { namespace: 'personal' });
  const entityIds = new Set(entities.map((e) => e.id));
  const relations = collectRelations(brain, entityIds, {
    namespace: 'personal',
    dropDangling: false,
  });

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
