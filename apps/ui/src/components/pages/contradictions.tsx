import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, Check, X, Network, RefreshCw } from 'lucide-react';
import { useContradictionsStore } from '../../store/contradictions-store.js';
import { TypeBadge, RelationBadge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { EmptyState } from '../ui/empty-state.js';
import { LoadingState } from '../ui/loading.js';
import { Button } from '../ui/button.js';
import type { Entity } from '../../lib/types.js';

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-full bg-zinc-800">
        <div
          className="h-2 rounded-full bg-indigo-500/50"
          style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
        />
      </div>
      <span className="text-xs text-zinc-500">{(value * 100).toFixed(0)}%</span>
    </div>
  );
}

function EntityPanel({ entity, label }: { entity: Entity; label: string }) {
  return (
    <div className="rounded-lg bg-zinc-800/50 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-600">
        {label}
      </div>
      <div className="mb-2 flex items-center gap-2">
        <TypeBadge type={entity.type} />
        <span className="text-sm font-medium text-zinc-200">{entity.name}</span>
      </div>
      <ConfidenceBar value={entity.confidence} />
      {entity.observations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {entity.observations.slice(0, 3).map((obs, i) => (
            <li key={i} className="text-xs text-zinc-400">
              - {obs}
            </li>
          ))}
          {entity.observations.length > 3 && (
            <li className="text-xs text-zinc-600">
              +{entity.observations.length - 3} more
            </li>
          )}
        </ul>
      )}
      <div className="mt-2 text-xs text-zinc-600">
        Created {new Date(entity.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

export function ContradictionsPage() {
  const { contradictions, loading, error, resolving, fetch, resolve, dismiss } =
    useContradictionsStore();
  const navigate = useNavigate();
  const [confirmAction, setConfirmAction] = useState<{
    relationId: string;
    winnerId: string;
    winnerName: string;
    loserName: string;
  } | null>(null);

  useEffect(() => {
    fetch();
  }, [fetch]);

  function handleResolve(relationId: string, winnerId: string, winnerName: string, loserName: string) {
    setConfirmAction({ relationId, winnerId, winnerName, loserName });
  }

  function confirmResolve() {
    if (confirmAction) {
      resolve(confirmAction.relationId, confirmAction.winnerId);
      setConfirmAction(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-100">Contradictions</h1>
          <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
            {contradictions.length}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={fetch}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {loading && <LoadingState message="Loading contradictions..." />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && contradictions.length === 0 && (
        <EmptyState
          icon={<AlertTriangle className="h-12 w-12" />}
          title="No unresolved contradictions"
          description="Contradictions are flagged when entities have conflicting information."
        />
      )}

      {!loading && contradictions.length > 0 && (
        <div className="space-y-4">
          {contradictions.map((c) => (
            <Card key={c.relation.id}>
              <div className="mb-3 flex items-center justify-center">
                <RelationBadge type="contradicts" />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <EntityPanel entity={c.entityA} label="Entity A" />
                <EntityPanel entity={c.entityB} label="Entity B" />
              </div>

              <div className="mt-3 flex items-center justify-end gap-2 border-t border-zinc-800 pt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleResolve(c.relation.id, c.entityA.id, c.entityA.name, c.entityB.name)}
                  disabled={resolving === c.relation.id}
                >
                  <Check className="mr-1 h-3 w-3" /> Pick A
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleResolve(c.relation.id, c.entityB.id, c.entityB.name, c.entityA.name)}
                  disabled={resolving === c.relation.id}
                >
                  <Check className="mr-1 h-3 w-3" /> Pick B
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dismiss(c.relation.id)}
                  disabled={resolving === c.relation.id}
                >
                  <X className="mr-1 h-3 w-3" /> Dismiss
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(`/graph/${c.entityA.id}`)}
                >
                  <Network className="mr-1 h-3 w-3" /> Graph
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-medium text-zinc-100">Resolve Contradiction</h3>
            <p className="mb-6 text-sm text-zinc-400">
              This will supersede &quot;{confirmAction.loserName}&quot; in favor of &quot;
              {confirmAction.winnerName}&quot;. A <code className="text-zinc-300">supersedes</code>{' '}
              relation will be created and the loser&apos;s confidence will be set to 0.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={confirmResolve}>
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
