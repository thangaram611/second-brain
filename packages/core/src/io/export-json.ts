import type { Brain } from '../brain.js';
import { collectEntities, collectRelations } from './collect.js';
import type { ExportOptions } from './types.js';

export function exportJson(brain: Brain, opts: ExportOptions): string {
  const entities = collectEntities(brain, opts);
  const entityIds = new Set(entities.map((e) => e.id));

  const includeRelations = opts.includeRelations !== false;
  const relations = includeRelations
    ? collectRelations(brain, entityIds, { namespace: opts.namespace })
    : [];

  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    entities,
    relations,
  });
}
