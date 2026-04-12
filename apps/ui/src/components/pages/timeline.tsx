import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Calendar } from 'lucide-react';
import { useTimelineStore } from '../../store/timeline-store.js';
import { TypeBadge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { EmptyState } from '../ui/empty-state.js';
import { LoadingState } from '../ui/loading.js';
import { ENTITY_COLORS } from '../../lib/colors.js';
import type { EntityType, TimelineEntry } from '../../lib/types.js';
import { ENTITY_TYPES } from '../../lib/types.js';

function toDateInputValue(iso: string): string {
  return iso.split('T')[0];
}

function fromDateInputValue(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`;
}

function toDateInputValueEnd(dateStr: string): string {
  return `${dateStr}T23:59:59.999Z`;
}

function groupByDate(entries: TimelineEntry[]): Map<string, TimelineEntry[]> {
  const grouped = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const date = entry.timestamp.split('T')[0];
    const group = grouped.get(date) ?? [];
    group.push(entry);
    grouped.set(date, group);
  }
  return grouped;
}

export function TimelinePage() {
  const { entries, loading, error, filters, setFilters, fetch } = useTimelineStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetch();
  }, [fetch]);

  const grouped = groupByDate(entries);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-zinc-100">Timeline</h1>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500">From</label>
          <input
            type="date"
            value={toDateInputValue(filters.from)}
            onChange={(e) => {
              setFilters({ from: fromDateInputValue(e.target.value) });
              fetch();
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500">To</label>
          <input
            type="date"
            value={toDateInputValue(filters.to)}
            onChange={(e) => {
              setFilters({ to: toDateInputValueEnd(e.target.value) });
              fetch();
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Type filter chips */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          onClick={() => {
            setFilters({ types: undefined });
            fetch();
          }}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            !filters.types
              ? 'bg-indigo-600 text-white'
              : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          All types
        </button>
        {ENTITY_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => {
              setFilters({ types: type });
              fetch();
            }}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              filters.types === type
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && <LoadingState message="Loading timeline..." />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <EmptyState
          icon={<Calendar className="h-12 w-12" />}
          title="No activity in this time range"
          description="Try expanding the date range or removing type filters."
        />
      )}

      {!loading && entries.length > 0 && (
        <div className="border-l-2 border-zinc-700 ml-4 pl-6 space-y-1">
          {[...grouped.entries()].map(([date, group]) => (
            <div key={date}>
              <div className="sticky top-0 z-10 -ml-[33px] bg-zinc-950/80 py-2 text-xs font-medium uppercase tracking-wider text-zinc-500 backdrop-blur-sm">
                <span className="ml-[33px]">{formatDate(date)}</span>
              </div>
              <div className="space-y-2">
                {group.map((entry) => (
                  <div
                    key={`${entry.entityId}-${entry.changeType}-${entry.timestamp}`}
                    className="relative"
                  >
                    <div
                      className="absolute -left-[33px] top-4 h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: ENTITY_COLORS[entry.entityType] }}
                    />
                    <Card className="cursor-pointer hover:border-zinc-700" >
                      <div
                        className="flex items-center gap-3"
                        onClick={() => navigate(`/entities/${entry.entityId}`)}
                      >
                        <TypeBadge type={entry.entityType} />
                        <span className="text-sm font-medium text-zinc-200">
                          {entry.entityName}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            entry.changeType === 'created'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-blue-500/20 text-blue-300'
                          }`}
                        >
                          {entry.changeType}
                        </span>
                        <span className="ml-auto text-xs text-zinc-600">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </Card>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
