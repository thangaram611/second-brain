export type {
  EntityType,
  Entity,
  EntitySource,
  EntitySourceType,
  CreateEntityInput,
  UpdateEntityInput,
} from './entity.js';
export { ENTITY_TYPES, ENTITY_SOURCE_TYPES, DECAY_RATES } from './entity.js';

export type {
  RelationType,
  Relation,
  CreateRelationInput,
  UpdateRelationInput,
} from './relation.js';
export { RELATION_TYPES } from './relation.js';

export {
  SESSION_NAMESPACE_PREFIX,
  sessionNamespace,
  isSessionNamespace,
  extractSessionId,
} from './namespace.js';

export {
  BRANCH_STATUSES,
  BranchContextSchema,
  BranchStatusPatchSchema,
} from './branch-context.js';
export type { BranchContext, BranchStatusPatch } from './branch-context.js';

export { AuthorSchema, canonicalizeEmail, gitlabNoreplyEmail } from './author.js';
export type { Author } from './author.js';

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
