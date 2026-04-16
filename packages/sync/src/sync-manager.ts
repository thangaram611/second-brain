import * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type {
  SyncConfig,
  SyncStatus,
  PeerInfo,
  SyncConflict,
  Entity,
  Relation,
} from '@second-brain/types';
import type { EntityManager, RelationManager } from '@second-brain/core';
import { createBrainDoc } from './crdt/schema.js';
import { hydrateDocFromDatabase } from './crdt/hydrate.js';
import { SyncBridge } from './crdt/bridge.js';
import { createSyncProvider } from './provider/hocuspocus-client.js';

export interface SyncSession {
  doc: Y.Doc;
  bridge: SyncBridge;
  provider: HocuspocusProvider;
  status: SyncStatus;
}

export type SyncWsEvent =
  | { type: 'sync:connected'; namespace: string; peers: number }
  | { type: 'sync:disconnected'; namespace: string }
  | { type: 'sync:peer-joined'; namespace: string; peer: PeerInfo }
  | { type: 'sync:peer-left'; namespace: string; peerId: number }
  | { type: 'sync:conflict'; namespace: string; conflict: SyncConflict };

export class SyncManager {
  private sessions: Map<string, SyncSession> = new Map();
  private entityManager: EntityManager;
  private relationManager: RelationManager;

  onSyncEvent?: (event: SyncWsEvent) => void;

  constructor(entityManager: EntityManager, relationManager: RelationManager) {
    this.entityManager = entityManager;
    this.relationManager = relationManager;
  }

  async join(config: SyncConfig): Promise<SyncStatus> {
    if (config.namespace === 'personal') {
      throw new Error('Cannot sync the "personal" namespace');
    }

    const existing = this.sessions.get(config.namespace);
    if (existing) return existing.status;

    // Build session locally; only insert into map when fully constructed
    const doc = createBrainDoc();
    try {
      const status: SyncStatus = {
        namespace: config.namespace,
        state: 'connecting',
        connectedPeers: 0,
        lastSyncedAt: null,
        pendingChanges: 0,
        error: null,
      };

      hydrateDocFromDatabase(doc, this.entityManager, this.relationManager, config.namespace);

      const bridge = new SyncBridge({
        doc,
        entityManager: this.entityManager,
        relationManager: this.relationManager,
        namespace: config.namespace,
        onConflict: (conflict: SyncConflict) => {
          this.onSyncEvent?.({
            type: 'sync:conflict',
            namespace: config.namespace,
            conflict,
          });
        },
      });

      const provider = createSyncProvider(doc, config, {
        onConnect: () => {
          this.updateStatus(config.namespace, (s) => {
            s.state = 'connected';
          });
          this.onSyncEvent?.({
            type: 'sync:connected',
            namespace: config.namespace,
            peers: this.sessions.get(config.namespace)?.status.connectedPeers ?? 0,
          });
        },
        onDisconnect: () => {
          this.updateStatus(config.namespace, (s) => {
            s.state = 'disconnected';
          });
          this.onSyncEvent?.({
            type: 'sync:disconnected',
            namespace: config.namespace,
          });
        },
        onSynced: () => {
          this.updateStatus(config.namespace, (s) => {
            s.state = 'connected';
            s.lastSyncedAt = new Date().toISOString();
          });
        },
        onAwarenessUpdate: (states: Map<number, Record<string, unknown>>) => {
          this.updateStatus(config.namespace, (s) => {
            s.connectedPeers = states.size;
          });
        },
      });

      bridge.startObserving();

      this.sessions.set(config.namespace, { doc, bridge, provider, status });

      return status;
    } catch (err) {
      doc.destroy();
      throw err;
    }
  }

  async leave(namespace: string): Promise<void> {
    const session = this.sessions.get(namespace);
    if (!session) return;

    session.bridge.stopObserving();
    session.provider.destroy();
    session.doc.destroy();
    this.sessions.delete(namespace);
  }

  getStatus(namespace: string): SyncStatus | null {
    return this.sessions.get(namespace)?.status ?? null;
  }

  getAllStatuses(): SyncStatus[] {
    return Array.from(this.sessions.values()).map((s) => s.status);
  }

  getPeers(namespace: string): PeerInfo[] {
    const session = this.sessions.get(namespace);
    if (!session) return [];

    const peers: PeerInfo[] = [];
    const states = session.provider.awareness?.getStates();
    if (!states) return [];

    for (const [clientId, state] of states.entries()) {
      if (clientId === session.provider.document?.clientID) continue;

      const user = extractUser(state);
      peers.push({
        clientId,
        name: user.name,
        color: user.color,
        connectedAt: user.connectedAt,
      });
    }

    return peers;
  }

  isSynced(namespace: string): boolean {
    const status = this.sessions.get(namespace)?.status;
    return status?.state === 'connected' && status.lastSyncedAt !== null;
  }

  // ---- Local change forwarding ----

  onLocalEntityChange(entity: Entity): void {
    this.sessions.get(entity.namespace)?.bridge.pushEntityToDoc(entity);
  }

  onLocalEntityDelete(entityId: string, namespace: string): void {
    this.sessions.get(namespace)?.bridge.deleteEntityFromDoc(entityId);
  }

  onLocalRelationChange(relation: Relation): void {
    this.sessions.get(relation.namespace)?.bridge.pushRelationToDoc(relation);
  }

  onLocalRelationDelete(relationId: string, namespace: string): void {
    this.sessions.get(namespace)?.bridge.deleteRelationFromDoc(relationId);
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      session.bridge.stopObserving();
      session.provider.destroy();
      session.doc.destroy();
    }
    this.sessions.clear();
  }

  // ---- Private helpers ----

  private updateStatus(namespace: string, fn: (s: SyncStatus) => void): void {
    const session = this.sessions.get(namespace);
    if (session) {
      fn(session.status);
    }
  }
}

// ---- Helpers ----

function extractUser(state: Record<string, unknown>): {
  name: string;
  color: string;
  connectedAt: string;
} {
  const user =
    typeof state === 'object' && state !== null && 'user' in state
      ? state.user
      : null;

  if (typeof user === 'object' && user !== null) {
    const u: Record<string, unknown> = Object.fromEntries(Object.entries(user));
    return {
      name: typeof u.name === 'string' ? u.name : 'unknown',
      color: typeof u.color === 'string' ? u.color : '#888',
      connectedAt: typeof u.connectedAt === 'string' ? u.connectedAt : new Date().toISOString(),
    };
  }

  return { name: 'unknown', color: '#888', connectedAt: new Date().toISOString() };
}
