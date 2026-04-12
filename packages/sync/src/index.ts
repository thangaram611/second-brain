// CRDT schema
export {
  createBrainDoc,
  entityToYMap,
  yMapToEntity,
  relationToYMap,
  yMapToRelation,
  setObservations,
  getObservations,
  setTags,
  getTags,
} from './crdt/schema.js';

// CRDT hydration
export { hydrateDocFromDatabase } from './crdt/hydrate.js';

// CRDT bridge
export { SyncBridge } from './crdt/bridge.js';

// Sync manager
export { SyncManager } from './sync-manager.js';
export type { SyncWsEvent } from './sync-manager.js';

// Provider
export { createSyncProvider } from './provider/hocuspocus-client.js';
export type { SyncProviderCallbacks } from './provider/hocuspocus-client.js';
