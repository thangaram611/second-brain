import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Box,
  GitBranch,
  Layers,
  TrendingUp,
  Plus,
} from 'lucide-react';
import { useStatsStore } from '../../store/stats-store.js';
import { Card } from '../ui/card.js';
import { Button } from '../ui/button.js';
import { TypeBadge } from '../ui/badge.js';
import { LoadingState } from '../ui/loading.js';
import { EmptyState } from '../ui/empty-state.js';
import { CreateEntityDialog } from '../entity/create-entity-dialog.js';
import type { Entity, EntityType } from '../../lib/types.js';
import { api } from '../../lib/api.js';

export function Dashboard() {
  const { stats, loading, fetchStats } = useStatsStore();
  const [recentEntities, setRecentEntities] = useState<Entity[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetchStats();
    api.entities.list({ limit: 10 }).then(setRecentEntities).catch(() => {});
  }, [fetchStats]);

  if (loading && !stats) return <LoadingState message="Loading dashboard..." />;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-100">Dashboard</h1>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          New Entity
        </Button>
      </div>

      {/* Stats cards */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-500/10 p-2">
              <Box className="h-5 w-5 text-indigo-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-zinc-100">{stats?.totalEntities ?? 0}</p>
              <p className="text-sm text-zinc-500">Entities</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-500/10 p-2">
              <GitBranch className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-zinc-100">{stats?.totalRelations ?? 0}</p>
              <p className="text-sm text-zinc-500">Relations</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-500/10 p-2">
              <Layers className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-zinc-100">{stats?.namespaces.length ?? 0}</p>
              <p className="text-sm text-zinc-500">Namespaces</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Entities by type */}
      {stats && Object.keys(stats.entitiesByType).length > 0 && (
        <Card className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <TrendingUp className="h-4 w-4" />
            Entities by Type
          </h2>
          <div className="space-y-2">
            {Object.entries(stats.entitiesByType)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => {
                const max = Math.max(...Object.values(stats.entitiesByType));
                const pct = max > 0 ? (count / max) * 100 : 0;
                return (
                  <div key={type} className="flex items-center gap-3">
                    <TypeBadge type={type as EntityType} />
                    <div className="flex-1">
                      <div className="h-2 rounded-full bg-zinc-800">
                        <div
                          className="h-2 rounded-full bg-indigo-500/50 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <span className="min-w-[2rem] text-right text-sm text-zinc-400">{count}</span>
                  </div>
                );
              })}
          </div>
        </Card>
      )}

      {/* Recent entities */}
      <Card>
        <h2 className="mb-4 text-sm font-medium text-zinc-300">Recent Entities</h2>
        {recentEntities.length === 0 ? (
          <EmptyState
            title="No entities yet"
            description="Create your first entity to get started"
            action={
              <Button onClick={() => setShowCreate(true)} size="sm">
                <Plus className="mr-1.5 h-4 w-4" />
                Create Entity
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-zinc-800">
            {recentEntities.map((entity) => (
              <button
                key={entity.id}
                onClick={() => navigate(`/entities/${entity.id}`)}
                className="flex w-full items-center gap-3 px-2 py-3 text-left transition-colors hover:bg-zinc-800/50"
              >
                <TypeBadge type={entity.type} />
                <span className="flex-1 truncate text-sm text-zinc-200">{entity.name}</span>
                <span className="text-xs text-zinc-600">
                  {new Date(entity.updatedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <CreateEntityDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}
