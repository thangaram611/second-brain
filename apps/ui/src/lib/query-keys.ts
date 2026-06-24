/**
 * Typed TanStack Query key factory. Centralising keys here keeps
 * `setQueryData` call sites (in the WebSocket handlers) type-safe and avoids
 * stringly-typed keys drifting between the reader and the writer.
 *
 * `as const` on each tuple narrows the literals; this is a literal-narrowing
 * assertion on array contents, not a type cast that erases information, so it
 * does not violate the no-`as`-cast rule.
 */

interface SearchFilters {
  types?: string;
  namespace?: string;
  minConfidence?: number;
}

interface TimelineFilters {
  from: string;
  to: string;
  types?: string;
  namespace?: string;
}

export const queryKeys = {
  entities: {
    list: (limit: number) => ['entities', 'list', limit] as const,
    get: (id: string) => ['entities', 'get', id] as const,
    neighbors: (id: string, depth: number) => ['entities', 'neighbors', id, depth] as const,
  },
  graph: {
    /** Accumulated graph entities/relations rendered by the explorer. */
    data: (scope: string) => ['graph', scope] as const,
  },
  search: (query: string, filters: SearchFilters) => ['search', query, filters] as const,
  timeline: (filters: TimelineFilters) => ['timeline', filters] as const,
  contradictions: () => ['contradictions'] as const,
  ownershipTree: (path: string) => ['ownership', 'tree', path] as const,
  stats: (namespace?: string) => ['stats', namespace ?? null] as const,
  decisions: (sort: string) => ['decisions', sort] as const,
  sync: {
    status: () => ['sync', 'status'] as const,
    peers: (namespace: string) => ['sync', 'peers', namespace] as const,
  },
  parallelWork: () => ['parallel-work'] as const,
} as const;
