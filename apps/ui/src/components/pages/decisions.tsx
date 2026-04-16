import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Scale, ChevronRight, Network, ExternalLink } from 'lucide-react';
import type { Entity, NeighborResult } from '../../lib/types.js';
import { api } from '../../lib/api.js';
import { useAsync } from '../../hooks/use-async.js';
import { TypeBadge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { EmptyState } from '../ui/empty-state.js';
import { LoadingState } from '../ui/loading.js';
import { Button } from '../ui/button.js';

export function DecisionsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<NeighborResult | null>(null);
  const navigate = useNavigate();

  const { data: decisions, loading, error } = useAsync(
    () => api.decisions({ sort: sortOrder, limit: 200 }),
    [sortOrder],
  );

  // Filter client-side by search query
  const filtered = searchQuery
    ? (decisions ?? []).filter(
        (d) =>
          d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          d.observations.some((o) => o.toLowerCase().includes(searchQuery.toLowerCase())),
      )
    : (decisions ?? []);

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setNeighbors(null);
      return;
    }
    setExpandedId(id);
    try {
      const result = await api.entities.neighbors(id, { depth: 1, relationTypes: 'decided_in' });
      setNeighbors(result);
    } catch {
      setNeighbors(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-100">Decision Log</h1>
        <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
          {filtered.length} decision{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Controls */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <input
          type="text"
          placeholder="Search decisions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <div className="flex items-center gap-1">
          <Button
            variant={sortOrder === 'newest' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSortOrder('newest')}
          >
            Newest
          </Button>
          <Button
            variant={sortOrder === 'oldest' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSortOrder('oldest')}
          >
            Oldest
          </Button>
        </div>
      </div>

      {/* Content */}
      {loading && <LoadingState message="Loading decisions..." />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          icon={<Scale className="h-12 w-12" />}
          title="No decisions recorded yet"
          description="Decisions can be recorded via the MCP server, CLI, or API."
        />
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((decision) => (
            <Card key={decision.id}>
              <div
                className="flex cursor-pointer items-center gap-3"
                onClick={() => toggleExpand(decision.id)}
              >
                <ChevronRight
                  className={`h-4 w-4 text-zinc-500 transition-transform ${
                    expandedId === decision.id ? 'rotate-90' : ''
                  }`}
                />
                <TypeBadge type="decision" />
                <span className="flex-1 text-sm font-medium text-zinc-200">
                  {decision.name}
                </span>
                <span className="text-xs text-zinc-600">
                  {new Date(decision.eventTime).toLocaleDateString()}
                </span>
                <span className="text-xs text-zinc-500">
                  {(decision.confidence * 100).toFixed(0)}%
                </span>
              </div>

              {/* Tags */}
              {decision.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 pl-7">
                  {decision.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Expanded */}
              {expandedId === decision.id && (
                <div className="mt-4 border-t border-zinc-800 pt-4 pl-7">
                  {decision.observations.length > 0 && (
                    <div className="mb-4">
                      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                        Observations
                      </h4>
                      <ul className="space-y-1">
                        {decision.observations.map((obs, i) => (
                          <li key={i} className="text-sm text-zinc-400">
                            - {obs}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {neighbors && neighbors.entities.length > 0 && (
                    <div className="mb-4">
                      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                        Related Entities
                      </h4>
                      <div className="space-y-1">
                        {neighbors.entities
                          .filter((e) => e.id !== decision.id)
                          .map((entity) => (
                            <div
                              key={entity.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800"
                              onClick={() => navigate(`/entities/${entity.id}`)}
                            >
                              <TypeBadge type={entity.type} />
                              <span className="text-sm text-zinc-300">{entity.name}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/graph/${decision.id}`)}
                    >
                      <Network className="mr-1 h-3 w-3" /> View in Graph
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/entities/${decision.id}`)}
                    >
                      <ExternalLink className="mr-1 h-3 w-3" /> Detail
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
