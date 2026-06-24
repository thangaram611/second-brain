import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, X, Network, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { removeContradiction } from '../../lib/ws-cache.js';
import { TypeBadge, RelationBadge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { EmptyState } from '../ui/empty-state.js';
import { LoadingState } from '../ui/loading.js';
import { ErrorState } from '../ui/error-state.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { Button } from '../ui/button.js';
import type { Contradiction, Entity } from '../../lib/types.js';

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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmAction, setConfirmAction] = useState<{
    relationId: string;
    winnerId: string;
    winnerName: string;
    loserName: string;
  } | null>(null);

  const contradictionsQuery = useQuery({
    queryKey: queryKeys.contradictions(),
    queryFn: () => api.contradictions.list(),
  });
  const contradictions = contradictionsQuery.data ?? [];
  const loading = contradictionsQuery.isFetching;

  function dropContradiction(relationId: string) {
    queryClient.setQueryData<Contradiction[]>(queryKeys.contradictions(), (prev) =>
      removeContradiction(prev, relationId),
    );
  }

  const resolveMutation = useMutation({
    mutationFn: ({ relationId, winnerId }: { relationId: string; winnerId: string }) =>
      api.contradictions.resolve(relationId, winnerId),
    onSuccess: (_result, { relationId }) => dropContradiction(relationId),
  });

  const dismissMutation = useMutation({
    mutationFn: (relationId: string) => api.contradictions.dismiss(relationId),
    onSuccess: (_result, relationId) => dropContradiction(relationId),
  });

  const resolvingId = resolveMutation.isPending
    ? resolveMutation.variables.relationId
    : dismissMutation.isPending
      ? dismissMutation.variables
      : null;

  const error =
    contradictionsQuery.error instanceof Error
      ? contradictionsQuery.error.message
      : resolveMutation.error instanceof Error
        ? resolveMutation.error.message
        : dismissMutation.error instanceof Error
          ? dismissMutation.error.message
          : null;

  function handleResolve(relationId: string, winnerId: string, winnerName: string, loserName: string) {
    setConfirmAction({ relationId, winnerId, winnerName, loserName });
  }

  function confirmResolve() {
    if (confirmAction) {
      resolveMutation.mutate({
        relationId: confirmAction.relationId,
        winnerId: confirmAction.winnerId,
      });
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
        <Button variant="ghost" size="sm" onClick={() => void contradictionsQuery.refetch()}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {loading && <LoadingState message="Loading contradictions..." />}
      {error && <ErrorState message={error} onRetry={() => void contradictionsQuery.refetch()} />}

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
                  disabled={resolvingId === c.relation.id}
                >
                  <Check className="mr-1 h-3 w-3" /> Pick A
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleResolve(c.relation.id, c.entityB.id, c.entityB.name, c.entityA.name)}
                  disabled={resolvingId === c.relation.id}
                >
                  <Check className="mr-1 h-3 w-3" /> Pick B
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dismissMutation.mutate(c.relation.id)}
                  disabled={resolvingId === c.relation.id}
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
      <ConfirmDialog
        open={confirmAction !== null}
        title="Resolve Contradiction"
        description={
          confirmAction && (
            <>
              This will supersede &quot;{confirmAction.loserName}&quot; in favor of &quot;
              {confirmAction.winnerName}&quot;. A{' '}
              <code className="text-zinc-300">supersedes</code> relation will be created and the
              loser&apos;s confidence will be set to 0.
            </>
          )
        }
        busy={resolveMutation.isPending}
        onConfirm={confirmResolve}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
