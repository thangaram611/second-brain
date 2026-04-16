import { useEffect } from 'react';
import { subscribe } from '../lib/ws.js';
import type { WsEvent } from '../lib/ws.js';
import { useGraphStore } from '../store/graph-store.js';
import { useContradictionsStore } from '../store/contradictions-store.js';
import { useSyncStore } from '../store/sync-store.js';

type EventHandler = (event: Extract<WsEvent, { type: string }>) => void;

const handlers: Record<string, EventHandler> = {
  'entity:created': (e) => useGraphStore.getState().handleEntityCreated((e as Extract<WsEvent, { type: 'entity:created' }>).entity),
  'entity:updated': (e) => useGraphStore.getState().handleEntityUpdated((e as Extract<WsEvent, { type: 'entity:updated' }>).entity),
  'entity:deleted': (e) => useGraphStore.getState().handleEntityDeleted((e as Extract<WsEvent, { type: 'entity:deleted' }>).id),
  'relation:created': (e) => useGraphStore.getState().handleRelationCreated((e as Extract<WsEvent, { type: 'relation:created' }>).relation),
  'relation:deleted': (e) => useGraphStore.getState().handleRelationDeleted((e as Extract<WsEvent, { type: 'relation:deleted' }>).id),
  'contradiction:resolved': (e) => useContradictionsStore.getState().handleContradictionResolved((e as Extract<WsEvent, { type: 'contradiction:resolved' }>).relationId),
  'contradiction:dismissed': (e) => useContradictionsStore.getState().handleContradictionDismissed((e as Extract<WsEvent, { type: 'contradiction:dismissed' }>).relationId),
  'sync:connected': (e) => {
    const ev = e as Extract<WsEvent, { type: 'sync:connected' }>;
    useSyncStore.getState().handleSyncConnected(ev.namespace, ev.peers);
  },
  'sync:disconnected': (e) => useSyncStore.getState().handleSyncDisconnected((e as Extract<WsEvent, { type: 'sync:disconnected' }>).namespace),
  'sync:peer-joined': (e) => {
    const ev = e as Extract<WsEvent, { type: 'sync:peer-joined' }>;
    useSyncStore.getState().handlePeerJoined(ev.namespace, ev.peer);
  },
  'sync:peer-left': (e) => {
    const ev = e as Extract<WsEvent, { type: 'sync:peer-left' }>;
    useSyncStore.getState().handlePeerLeft(ev.namespace, ev.peerId);
  },
};

export function useWebSocket(): void {
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      const handler = handlers[event.type];
      if (handler) handler(event);
    });
    return unsubscribe;
  }, []);
}
