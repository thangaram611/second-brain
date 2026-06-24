import { useEffect } from 'react';
import { subscribe } from '../lib/ws.js';
import type { WsEvent } from '../lib/ws.js';
import { queryClient, invalidateDerivedViews } from '../lib/query-client.js';
import { queryKeys } from '../lib/query-keys.js';
import { graphKey } from './use-graph.js';
import type { GraphData } from '../lib/ws-cache.js';
import {
  upsertEntity,
  deleteEntity,
  addRelation,
  deleteRelation,
  removeContradiction,
  patchSyncStatus,
} from '../lib/ws-cache.js';
import type { Contradiction, SyncStatus } from '../lib/types.js';

/**
 * Live-update handlers patch the relevant TanStack Query caches via
 * setQueryData. The discriminated WsEvent union (parsed by Zod in ws.ts)
 * makes this map exhaustively typed without `as` casts — each branch narrows
 * `event` to its variant. Events we don't materialise into a cache (connected,
 * sync:conflict) are intentionally no-ops here.
 */
function dispatch(event: WsEvent): void {
  switch (event.type) {
    case 'entity:created':
    case 'entity:updated':
      queryClient.setQueryData<GraphData>(graphKey, (prev) => upsertEntity(prev, event.entity));
      invalidateDerivedViews();
      return;
    case 'entity:deleted':
      queryClient.setQueryData<GraphData>(graphKey, (prev) => deleteEntity(prev, event.id));
      invalidateDerivedViews();
      return;
    case 'relation:created':
      queryClient.setQueryData<GraphData>(graphKey, (prev) => addRelation(prev, event.relation));
      invalidateDerivedViews();
      return;
    case 'relation:deleted':
      queryClient.setQueryData<GraphData>(graphKey, (prev) => deleteRelation(prev, event.id));
      invalidateDerivedViews();
      return;
    case 'contradiction:resolved':
    case 'contradiction:dismissed':
      queryClient.setQueryData<Contradiction[]>(queryKeys.contradictions(), (prev) =>
        removeContradiction(prev, event.relationId),
      );
      return;
    case 'sync:connected':
      queryClient.setQueryData<SyncStatus[]>(queryKeys.sync.status(), (prev) =>
        patchSyncStatus(prev, event.namespace, { state: 'connected', connectedPeers: event.peers }),
      );
      return;
    case 'sync:disconnected':
      queryClient.setQueryData<SyncStatus[]>(queryKeys.sync.status(), (prev) =>
        patchSyncStatus(prev, event.namespace, { state: 'disconnected', connectedPeers: 0 }),
      );
      return;
    case 'connected':
    case 'sync:conflict':
      return;
  }
}

export function useWebSocket(): void {
  useEffect(() => {
    return subscribe(dispatch);
  }, []);
}
