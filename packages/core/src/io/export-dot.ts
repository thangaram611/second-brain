import type { Brain } from '../brain.js';
import type { EntityType } from '@second-brain/types';
import { collectEntities, collectRelations } from './collect.js';
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

export function exportDot(brain: Brain, opts: ExportOptions): string {
  const entities = collectEntities(brain, opts);
  const entityIds = new Set(entities.map((e) => e.id));

  const includeRelations = opts.includeRelations !== false;
  const relations = includeRelations
    ? collectRelations(brain, entityIds, { namespace: opts.namespace })
    : [];

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
