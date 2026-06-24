import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { Plus } from 'lucide-react';
import { useGraph } from '../../hooks/use-graph.js';
import { GraphCanvas } from '../graph/graph-canvas.js';
import { GraphControls } from '../graph/graph-controls.js';
import { EntityDetail } from '../entity/entity-detail.js';
import { CreateEntityDialog } from '../entity/create-entity-dialog.js';
import { Button } from '../ui/button.js';
import { LoadingState } from '../ui/loading.js';
import { EmptyState } from '../ui/empty-state.js';
import { ErrorState } from '../ui/error-state.js';

export type LayoutName = 'cose' | 'grid' | 'circle' | 'breadthfirst';

export function GraphExplorer() {
  const { id } = useParams<{ id: string }>();
  const { entities: entityArray, relations, loading, error, expand, refetch } = useGraph(id);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(id ?? null);
  const [layout, setLayout] = useState<LayoutName>('cose');
  const [showCreate, setShowCreate] = useState(false);

  const handleNodeSelect = useCallback((entityId: string) => {
    setSelectedEntityId(entityId);
  }, []);

  const handleNodeExpand = useCallback(
    (entityId: string) => {
      expand(entityId);
    },
    [expand],
  );

  if (loading && entityArray.length === 0) {
    return <LoadingState message="Loading graph..." />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <GraphControls layout={layout} onLayoutChange={setLayout} />
        <Button onClick={() => setShowCreate(true)} size="sm" variant="secondary">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Entity
        </Button>
      </div>

      {error && entityArray.length === 0 ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : entityArray.length === 0 ? (
        <EmptyState
          title="No entities in graph"
          description="Create some entities to visualize them here"
          action={
            <Button onClick={() => setShowCreate(true)} size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              Create Entity
            </Button>
          }
        />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Graph canvas */}
          <div className="flex-1">
            <GraphCanvas
              entities={entityArray}
              relations={relations}
              selectedId={selectedEntityId}
              onSelect={handleNodeSelect}
              onExpand={handleNodeExpand}
              layout={layout}
            />
          </div>

          {/* Detail sidebar */}
          {selectedEntityId && (
            <div className="w-80 shrink-0 overflow-auto border-l border-zinc-800 p-4">
              <EntityDetail entityId={selectedEntityId} compact />
            </div>
          )}
        </div>
      )}

      <CreateEntityDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}
