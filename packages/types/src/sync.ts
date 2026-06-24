// --- Sync types (Phase 6: Team Sync) ---

import { z } from 'zod';

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

/** Permissions granted in a relay JWT */
export const RELAY_PERMISSIONS = ['read', 'write'] as const;

/**
 * Canonical Zod schema for the relay JWT payload — the single source of truth
 * shared by the issuer (the API server, via @second-brain/sync `signRelayToken`)
 * and the verifier (apps/relay/src/server.ts `verifyRelayToken`).
 * `iat`/`exp` are injected by jwt.sign; the issuer constructs the
 * sub/namespace/permissions subset, while the verifier validates the full signed
 * shape against this schema.
 */
export const RelayAuthPayloadSchema = z.object({
  sub: z.string(),
  namespace: z.string(),
  permissions: z.array(z.enum(RELAY_PERMISSIONS)),
  iat: z.number(),
  exp: z.number(),
});

/** JWT payload for relay authentication */
export type RelayAuthPayload = z.infer<typeof RelayAuthPayloadSchema>;
