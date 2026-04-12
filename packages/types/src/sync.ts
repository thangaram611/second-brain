// --- Sync types (Phase 6: Team Sync) ---

/** Per-namespace sync configuration */
export interface SyncConfig {
  namespace: string;
  relayUrl: string;
  token: string;
  enabled: boolean;
}

/** Runtime sync connection state */
export type SyncConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'syncing';

/** Runtime sync status for a namespace */
export interface SyncStatus {
  namespace: string;
  state: SyncConnectionState;
  connectedPeers: number;
  lastSyncedAt: string | null;
  pendingChanges: number;
  error: string | null;
}

/** Connected peer info from awareness protocol */
export interface PeerInfo {
  clientId: number;
  name: string;
  color: string;
  connectedAt: string;
}

/** Conflict detected during CRDT merge */
export interface SyncConflict {
  entityId: string;
  entityName: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedAt: string | null;
}

/** JWT payload for relay authentication */
export interface RelayAuthPayload {
  sub: string;
  namespace: string;
  permissions: ('read' | 'write')[];
  iat: number;
  exp: number;
}
