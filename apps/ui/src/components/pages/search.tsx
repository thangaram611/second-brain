import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Search as SearchIcon } from 'lucide-react';
import { useSearchStore } from '../../store/search-store.js';
import { useDebounce } from '../../hooks/use-debounce.js';
import { Input } from '../ui/input.js';
import { Card } from '../ui/card.js';
import { TypeBadge } from '../ui/badge.js';
import { LoadingState } from '../ui/loading.js';
import { EmptyState } from '../ui/empty-state.js';
import { ENTITY_TYPES, type EntityType } from '../../lib/types.js';

export function SearchPage() {
  const { query, results, loading, filters, setQuery, setFilters, search } =
    useSearchStore();
  const debouncedQuery = useDebounce(query, 300);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Initialize from URL
  useEffect(() => {
    const q = searchParams.get('q');
    if (q && !query) {
      setQuery(q);
    }
  }, [searchParams, query, setQuery]);

  // Auto-search on debounced query change
  useEffect(() => {
    if (debouncedQuery.trim()) {
      search();
    }
  }, [debouncedQuery, filters, search]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-zinc-100">Search</h1>

      <div className="relative mb-4">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search entities, observations, tags..."
          className="pl-10"
          autoFocus
        />
      </div>

      {/* Type filter chips */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          onClick={() => setFilters({ ...filters, types: undefined })}
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
            onClick={() => setFilters({ ...filters, types: type })}
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

      {/* Results */}
      {loading ? (
        <LoadingState message="Searching..." />
      ) : results.length > 0 ? (
        <div className="space-y-3">
          {results.map((result) => (
            <Card
              key={result.entity.id}
              className="cursor-pointer transition-colors hover:border-zinc-700"
            >
              <button
                onClick={() => navigate(`/entities/${result.entity.id}`)}
                className="w-full text-left"
              >
                <div className="flex items-center gap-3">
                  <TypeBadge type={result.entity.type} />
                  <span className="flex-1 font-medium text-zinc-200">
                    {result.entity.name}
                  </span>
                  <span className="text-xs text-zinc-500">
                    score: {result.score.toFixed(2)}
                  </span>
                </div>
                {result.entity.observations.length > 0 && (
                  <p className="mt-2 text-sm text-zinc-500">
                    {result.entity.observations[0]}
                  </p>
                )}
                {result.entity.tags.length > 0 && (
                  <div className="mt-2 flex gap-1">
                    {result.entity.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            </Card>
          ))}
        </div>
      ) : query.trim() ? (
        <EmptyState
          icon={<SearchIcon className="h-10 w-10" />}
          title="No results"
          description={`No entities found matching "${query}"`}
        />
      ) : (
        <EmptyState
          icon={<SearchIcon className="h-10 w-10" />}
          title="Search your brain"
          description="Type to search across entities, observations, and tags"
        />
      )}
    </div>
  );
}
