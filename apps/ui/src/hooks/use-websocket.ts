import { useEffect } from 'react';
import { subscribe } from '../lib/ws.js';
import { useGraphStore } from '../store/graph-store.js';

export function useWebSocket(): void {
  useEffect(() => {
    const store = useGraphStore.getState();
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'entity:created':
          store.handleEntityCreated(event.entity);
          break;
        case 'entity:updated':
          store.handleEntityUpdated(event.entity);
          break;
        case 'entity:deleted':
          store.handleEntityDeleted(event.id);
          break;
        case 'relation:created':
          store.handleRelationCreated(event.relation);
          break;
        case 'relation:deleted':
          store.handleRelationDeleted(event.id);
          break;
      }
    });
    return unsubscribe;
  }, []);
}
