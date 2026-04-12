export type {
  EntityType,
  Entity,
  EntitySource,
  CreateEntityInput,
  UpdateEntityInput,
} from './entity.js';
export { ENTITY_TYPES, DECAY_RATES } from './entity.js';

export type {
  RelationType,
  Relation,
  CreateRelationInput,
} from './relation.js';
export { RELATION_TYPES } from './relation.js';

export type {
  SearchChannel,
  SearchOptions,
  SearchResult,
  GraphTraversalOptions,
  GraphStats,
} from './search.js';

export type {
  TemporalQueryOptions,
  TimelineEntry,
  TimelineOptions,
  Contradiction,
  StaleEntityOptions,
  DecayEngineConfig,
  DecayRunResult,
} from './temporal.js';

export type {
  SyncConfig,
  SyncConnectionState,
  SyncStatus,
  PeerInfo,
  SyncConflict,
  RelayAuthPayload,
} from './sync.js';
