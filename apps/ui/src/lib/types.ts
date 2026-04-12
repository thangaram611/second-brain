export const ENTITY_TYPES = [
  'concept', 'decision', 'pattern', 'person', 'file',
  'symbol', 'event', 'tool', 'fact', 'conversation', 'reference',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATION_TYPES = [
  'relates_to', 'depends_on', 'implements', 'supersedes',
  'contradicts', 'derived_from', 'authored_by', 'decided_in',
  'uses', 'tests', 'contains', 'co_changes_with', 'preceded_by', 'blocks',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export interface EntitySource {
  type: string;
  ref?: string;
  actor?: string;
}

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  namespace: string;
  observations: string[];
  properties: Record<string, unknown>;
  confidence: number;
  eventTime: string;
  ingestTime: string;
  lastAccessedAt: string;
  accessCount: number;
  source: EntitySource;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  type: RelationType;
  sourceId: string;
  targetId: string;
  namespace: string;
  properties: Record<string, unknown>;
  confidence: number;
  weight: number;
  bidirectional: boolean;
  source: EntitySource;
  eventTime: string;
  ingestTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  entity: Entity;
  score: number;
  matchChannel: string;
  highlights?: string[];
}

export interface GraphStats {
  totalEntities: number;
  totalRelations: number;
  entitiesByType: Record<string, number>;
  relationsByType: Record<string, number>;
  namespaces: string[];
}

export interface EntityWithRelations {
  entity: Entity;
  outbound: Relation[];
  inbound: Relation[];
}

export interface NeighborResult {
  entities: Entity[];
  relations: Relation[];
}

// --- Temporal types (Phase 5) ---

export interface TimelineEntry {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  changeType: 'created' | 'updated';
  timestamp: string;
  confidence: number;
  namespace: string;
}

export interface Contradiction {
  relation: Relation;
  entityA: Entity;
  entityB: Entity;
}

export interface StaleEntity extends Entity {
  effectiveConfidence: number;
}

// --- Sync types (Phase 6) ---

export type SyncConnectionState = 'disconnected' | 'connecting' | 'connected' | 'syncing';

export interface SyncStatus {
  namespace: string;
  state: SyncConnectionState;
  connectedPeers: number;
  lastSyncedAt: string | null;
  pendingChanges: number;
  error: string | null;
}

export interface PeerInfo {
  clientId: number;
  name: string;
  color: string;
  connectedAt: string;
}

export interface SyncConflict {
  entityId: string;
  entityName: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedAt: string | null;
}
