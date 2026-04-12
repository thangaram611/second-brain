import type { EntityType } from '../../lib/types.js';
import { ENTITY_BG_CLASSES } from '../../lib/colors.js';

export function TypeBadge({ type }: { type: EntityType }) {
  const classes = ENTITY_BG_CLASSES[type] ?? 'bg-zinc-700 text-zinc-300';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {type}
    </span>
  );
}

export function RelationBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs font-medium text-zinc-400">
      {type.replace(/_/g, ' ')}
    </span>
  );
}
