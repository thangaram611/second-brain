import { useEffect } from 'react';
import { subscribe } from '../lib/ws.js';
import { useGraphStore } from '../store/graph-store.js';
import { useContradictionsStore } from '../store/contradictions-store.js';

export function useWebSocket(): void {
  useEffect(() => {
    const graphStore = useGraphStore.getState();
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'entity:created':
          graphStore.handleEntityCreated(event.entity);
          break;
        case 'entity:updated':
          graphStore.handleEntityUpdated(event.entity);
          break;
        case 'entity:deleted':
          graphStore.handleEntityDeleted(event.id);
          break;
        case 'relation:created':
          graphStore.handleRelationCreated(event.relation);
          break;
        case 'relation:deleted':
          graphStore.handleRelationDeleted(event.id);
          break;
        case 'contradiction:resolved':
          useContradictionsStore.getState().handleContradictionResolved(event.relationId);
          break;
        case 'contradiction:dismissed':
          useContradictionsStore.getState().handleContradictionDismissed(event.relationId);
          break;
      }
    });
    return unsubscribe;
  }, []);
}
