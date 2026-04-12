import { useNavigate } from 'react-router';
import { ArrowRight, ArrowLeft } from 'lucide-react';
import { RelationBadge } from '../ui/badge.js';
import type { Relation, Entity } from '../../lib/types.js';

interface RelationListProps {
  outbound: Relation[];
  inbound: Relation[];
  entities: Map<string, Entity>;
}

export function RelationList({ outbound, inbound, entities }: RelationListProps) {
  const navigate = useNavigate();

  function entityName(id: string): string {
    return entities.get(id)?.name ?? id.slice(0, 8) + '...';
  }

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        Relations ({outbound.length + inbound.length})
      </h3>

      {outbound.length === 0 && inbound.length === 0 ? (
        <p className="text-sm text-zinc-600">No relations</p>
      ) : (
        <div className="space-y-1">
          {outbound.map((rel) => (
            <button
              key={rel.id}
              onClick={() => navigate(`/entities/${rel.targetId}`)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-800"
            >
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              <RelationBadge type={rel.type} />
              <span className="flex-1 truncate text-zinc-300">{entityName(rel.targetId)}</span>
              {rel.weight < 1 && (
                <span className="text-xs text-zinc-600">{rel.weight.toFixed(1)}</span>
              )}
            </button>
          ))}
          {inbound.map((rel) => (
            <button
              key={rel.id}
              onClick={() => navigate(`/entities/${rel.sourceId}`)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-800"
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              <RelationBadge type={rel.type} />
              <span className="flex-1 truncate text-zinc-300">{entityName(rel.sourceId)}</span>
              {rel.weight < 1 && (
                <span className="text-xs text-zinc-600">{rel.weight.toFixed(1)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
