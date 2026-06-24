import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Network,
  Trash2,
  Clock,
  Eye,
  Shield,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { graphKey, deleteEntityFromCache } from '../../hooks/use-graph.js';
import type { Entity } from '../../lib/types.js';
import type { GraphData } from '../../lib/ws-cache.js';
import { upsertEntity } from '../../lib/ws-cache.js';
import { TypeBadge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { LoadingState } from '../ui/loading.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { ObservationList } from './observation-list.js';
import { RelationList } from './relation-list.js';

interface EntityDetailProps {
  entityId: string;
  compact?: boolean;
}

export function EntityDetail({ entityId, compact }: EntityDetailProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: queryKeys.entities.get(entityId),
    queryFn: () => api.entities.get(entityId),
  });
  const data = detailQuery.data;

  // The graph cache's entity Map resolves relation target/source names.
  const graphData = queryClient.getQueryData<GraphData>(graphKey);
  const entities = graphData?.entities ?? new Map<string, Entity>();

  function patchGraphEntity(entity: Entity) {
    queryClient.setQueryData<GraphData>(graphKey, (prev) => upsertEntity(prev, entity));
  }

  const addObservation = useMutation({
    mutationFn: (observation: string) => api.entities.addObservation(entityId, observation),
    onSuccess: (entity) => {
      patchGraphEntity(entity);
      void detailQuery.refetch();
    },
  });

  const removeObservation = useMutation({
    mutationFn: (observation: string) => api.entities.removeObservation(entityId, observation),
    onSuccess: (entity) => {
      patchGraphEntity(entity);
      void detailQuery.refetch();
    },
  });

  const deleteEntity = useMutation({
    mutationFn: () => api.entities.delete(entityId),
    onSuccess: () => {
      queryClient.setQueryData<GraphData>(graphKey, (prev) =>
        deleteEntityFromCache(prev, entityId),
      );
      setConfirmOpen(false);
      navigate('/');
    },
  });
  const deleteError =
    deleteEntity.error instanceof Error ? deleteEntity.error.message : null;

  if (detailQuery.isLoading && !data) return <LoadingState />;

  if (!data || data.entity.id !== entityId) return null;

  const { entity, outbound, inbound } = data;

  return (
    <div className={compact ? 'space-y-4' : 'mx-auto max-w-3xl space-y-6 p-6'}>
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <TypeBadge type={entity.type} />
          <h2 className={`font-bold text-zinc-100 ${compact ? 'text-lg' : 'text-2xl'}`}>
            {entity.name}
          </h2>
        </div>

        <div className="mt-2 flex flex-wrap gap-4 text-xs text-zinc-500">
          <span className="flex items-center gap-1">
            <Shield className="h-3 w-3" />
            Confidence: {(entity.confidence * 100).toFixed(0)}%
          </span>
          <span className="flex items-center gap-1">
            <Eye className="h-3 w-3" />
            Accessed: {entity.accessCount}x
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(entity.updatedAt).toLocaleDateString()}
          </span>
          <span>ns: {entity.namespace}</span>
        </div>

        {entity.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {entity.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Observations */}
      <Card>
        <ObservationList
          observations={entity.observations}
          onAdd={(obs) => addObservation.mutate(obs)}
          onRemove={(obs) => removeObservation.mutate(obs)}
        />
      </Card>

      {/* Relations */}
      <Card>
        <RelationList outbound={outbound} inbound={inbound} entities={entities} />
      </Card>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate(`/graph/${entityId}`)}
        >
          <Network className="mr-1.5 h-3.5 w-3.5" />
          View in Graph
        </Button>
        <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      {deleteError && <p className="text-sm text-red-400">{deleteError}</p>}

      <ConfirmDialog
        open={confirmOpen}
        danger
        title="Delete entity?"
        description={
          <>
            This permanently deletes &quot;{entity.name}&quot; and its relations.
          </>
        }
        confirmLabel="Delete"
        busy={deleteEntity.isPending}
        onConfirm={() => deleteEntity.mutate()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
