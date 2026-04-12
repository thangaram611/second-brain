import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Network,
  Trash2,
  Clock,
  Eye,
  Shield,
} from 'lucide-react';
import { useGraphStore } from '../../store/graph-store.js';
import { TypeBadge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { LoadingState } from '../ui/loading.js';
import { ObservationList } from './observation-list.js';
import { RelationList } from './relation-list.js';

interface EntityDetailProps {
  entityId: string;
  compact?: boolean;
}

export function EntityDetail({ entityId, compact }: EntityDetailProps) {
  const {
    selectedEntity,
    entities,
    loading,
    fetchEntity,
    addObservation,
    removeObservation,
    deleteEntity,
  } = useGraphStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchEntity(entityId);
  }, [entityId, fetchEntity]);

  if (loading && !selectedEntity) return <LoadingState />;

  const data = selectedEntity;
  if (!data || data.entity.id !== entityId) return null;

  const { entity, outbound, inbound } = data;

  async function handleDelete() {
    await deleteEntity(entityId);
    navigate('/');
  }

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
          onAdd={(obs) => addObservation(entityId, obs)}
          onRemove={(obs) => removeObservation(entityId, obs)}
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
        <Button variant="danger" size="sm" onClick={handleDelete}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
