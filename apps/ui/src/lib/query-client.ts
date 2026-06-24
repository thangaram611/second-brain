import { QueryClient } from '@tanstack/react-query';

/**
 * Module-singleton QueryClient. Exported so non-component code (the
 * WebSocket live-update handlers in use-websocket.ts) can call
 * `queryClient.setQueryData` without prop-drilling — mirroring how the
 * Zustand stores used to be globally accessible.
 *
 * Defaults match the previous hand-rolled behaviour: no refetch on window
 * focus, and a short staleTime so navigating back to a page reuses cache
 * instead of refiring every request.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

/**
 * Invalidate the aggregate/derived views that summarise the whole graph —
 * dashboard stats, entity lists, timeline, decision log. Any entity/relation
 * mutation (a local create/delete, or a WebSocket broadcast from another
 * client) must call this so those reads refetch instead of showing stale
 * counts. The graph cache itself is patched surgically via `setQueryData`, so
 * it is intentionally left out here.
 *
 * The arrays below are prefixes of the `queryKeys` factory entries
 * (`stats`, `entities.list`, `timeline`, `decisions`); TanStack matches by
 * prefix, so this covers every namespace/limit/sort/filter variant.
 */
export function invalidateDerivedViews(): void {
  void queryClient.invalidateQueries({ queryKey: ['stats'] });
  void queryClient.invalidateQueries({ queryKey: ['entities', 'list'] });
  void queryClient.invalidateQueries({ queryKey: ['timeline'] });
  void queryClient.invalidateQueries({ queryKey: ['decisions'] });
}
