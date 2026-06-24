import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { invalidateDerivedViews } from '../lib/query-client.js';
import type { GraphData } from '../lib/ws-cache.js';
import {
  emptyGraphData,
  mergeGraphData,
  setGraphData,
  upsertEntity,
  deleteEntity as deleteEntityFromCache,
} from '../lib/ws-cache.js';

const GRAPH_SCOPE = 'explorer';
const graphKey = queryKeys.graph.data(GRAPH_SCOPE);

/**
 * Centralises the explorer's accumulated graph cache under a single stable
 * query key. The graph merges neighbours across fetches into one `GraphData`
 * ({ entities Map + deduped relations }), so we model it as one query whose
 * value we mutate via setQueryData — mirroring the old graph-store Map-clone
 * semantics with immutable updates. Because the key is stable, the WebSocket
 * handlers (use-websocket.ts) patch the exact cache the canvas renders, so
 * live updates flow in without re-fetching.
 *
 * The route id drives the initial fetch (neighbours of `routeId`, else recent
 * entities) but is intentionally NOT part of the key: navigating to a new node
 * merges into the same accumulated graph rather than discarding it. An effect
 * re-runs the fetch when the route id changes.
 */
export function useGraph(routeId: string | undefined) {
  const queryClient = useQueryClient();
  const routeIdRef = useRef(routeId);
  routeIdRef.current = routeId;

  const query = useQuery({
    queryKey: graphKey,
    queryFn: async (): Promise<GraphData> => {
      const id = routeIdRef.current;
      if (id) {
        const result = await api.entities.neighbors(id, { depth: 2 });
        return mergeGraphData(queryClient.getQueryData<GraphData>(graphKey), result);
      }
      const list = await api.entities.list({ limit: 50 });
      const ids = list.map((e) => e.id);
      const relations = ids.length > 0 ? await api.relations.list(ids) : [];
      return setGraphData({ entities: list, relations });
    },
  });

  // The query auto-fetches on mount; re-fetch only when the route id actually
  // changes afterwards (the queryFn reads the latest id via the ref).
  const { refetch } = query;
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    void refetch();
  }, [routeId, refetch]);

  /** Expand a node's neighbours, merging the result into the shared cache. */
  const expand = useMutation({
    mutationFn: (entityId: string) => api.entities.neighbors(entityId, { depth: 1 }),
    onSuccess: (result) => {
      queryClient.setQueryData<GraphData>(graphKey, (prev) =>
        mergeGraphData(prev ?? emptyGraphData, result),
      );
    },
  });

  const data = query.data ?? emptyGraphData;

  return {
    entities: Array.from(data.entities.values()),
    relations: data.relations,
    loading: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    expand: (id: string) => expand.mutate(id),
    refetch: () => {
      void refetch();
    },
  };
}

/**
 * Standalone entity-create mutation. Lives outside `useGraph` so callers (the
 * create dialog) don't accidentally subscribe to the graph query and trigger a
 * loadRecent fetch just by mounting.
 */
export function useCreateEntity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.entities.create>[0]) =>
      api.entities.create(input),
    onSuccess: (entity) => {
      queryClient.setQueryData<GraphData>(graphKey, (prev) => upsertEntity(prev, entity));
      // Refresh aggregate views (dashboard stats, entity lists, timeline) so a
      // newly created entity shows up immediately instead of stale counts.
      invalidateDerivedViews();
    },
  });
}

/** Patch helpers exported for the entity-detail mutations and tests. */
export { graphKey, deleteEntityFromCache };
