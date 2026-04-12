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

export type SyncWsEvent =
  | { type: 'sync:connected'; namespace: string; peers: number }
  | { type: 'sync:disconnected'; namespace: string }
  | { type: 'sync:peer-joined'; namespace: string; peer: PeerInfo }
  | { type: 'sync:peer-left'; namespace: string; peerId: number }
  | { type: 'sync:conflict'; namespace: string; conflict: SyncConflict };

export class SyncManager {
  private docs: Map<string, Y.Doc> = new Map();
  private bridges: Map<string, SyncBridge> = new Map();
  private providers: Map<string, HocuspocusProvider> = new Map();
  private statuses: Map<string, SyncStatus> = new Map();
  private entityManager: EntityManager;
  private relationManager: RelationManager;

  onSyncEvent?: (event: SyncWsEvent) => void;

  constructor(entityManager: EntityManager, relationManager: RelationManager) {
    this.entityManager = entityManager;
    this.relationManager = relationManager;
  }

  async join(config: SyncConfig): Promise<SyncStatus> {
    // Guard: never sync the personal namespace
    if (config.namespace === 'personal') {
      throw new Error('Cannot sync the "personal" namespace');
    }

    // If already joined, return existing status
    const existing = this.statuses.get(config.namespace);
    if (existing) return existing;

    // 1. Create Y.Doc
    const doc = createBrainDoc();
    this.docs.set(config.namespace, doc);

    // 2. Initialize status
    const status: SyncStatus = {
      namespace: config.namespace,
      state: 'connecting',
      connectedPeers: 0,
      lastSyncedAt: null,
      pendingChanges: 0,
      error: null,
    };
    this.statuses.set(config.namespace, status);

    // 3. Hydrate from SQLite
    hydrateDocFromDatabase(doc, this.entityManager, this.relationManager, config.namespace);

    // 4. Create SyncBridge
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
    this.bridges.set(config.namespace, bridge);

    // 5. Create HocuspocusProvider
    const provider = createSyncProvider(doc, config, {
      onConnect: () => {
        const s = this.statuses.get(config.namespace);
        if (s) {
          s.state = 'connected';
        }
        this.onSyncEvent?.({
          type: 'sync:connected',
          namespace: config.namespace,
          peers: s?.connectedPeers ?? 0,
        });
      },
      onDisconnect: () => {
        const s = this.statuses.get(config.namespace);
        if (s) {
          s.state = 'disconnected';
        }
        this.onSyncEvent?.({
          type: 'sync:disconnected',
          namespace: config.namespace,
        });
      },
      onSynced: () => {
        const s = this.statuses.get(config.namespace);
        if (s) {
          s.state = 'connected';
          s.lastSyncedAt = new Date().toISOString();
        }
      },
      onAwarenessUpdate: (states: Map<number, Record<string, unknown>>) => {
        const s = this.statuses.get(config.namespace);
        if (s) {
          s.connectedPeers = states.size;
        }
      },
    });
    this.providers.set(config.namespace, provider);

    // 6. Start observing AFTER hydration to avoid echo writes
    bridge.startObserving();

    return status;
  }

  async leave(namespace: string): Promise<void> {
    const bridge = this.bridges.get(namespace);
    if (bridge) {
      bridge.stopObserving();
      this.bridges.delete(namespace);
    }

    const provider = this.providers.get(namespace);
    if (provider) {
      provider.destroy();
      this.providers.delete(namespace);
    }

    const doc = this.docs.get(namespace);
    if (doc) {
      doc.destroy();
      this.docs.delete(namespace);
    }

    this.statuses.delete(namespace);
  }

  getStatus(namespace: string): SyncStatus | null {
    return this.statuses.get(namespace) ?? null;
  }

  getAllStatuses(): SyncStatus[] {
    return Array.from(this.statuses.values());
  }

  getPeers(namespace: string): PeerInfo[] {
    const provider = this.providers.get(namespace);
    if (!provider) return [];

    const peers: PeerInfo[] = [];
    const states = provider.awareness?.getStates();
    if (!states) return [];

    for (const [clientId, state] of states.entries()) {
      if (clientId === provider.document?.clientID) continue; // Skip self

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
    const status = this.statuses.get(namespace);
    return status?.state === 'connected' && status.lastSyncedAt !== null;
  }

  // ---- Local change forwarding ----

  onLocalEntityChange(entity: Entity): void {
    const bridge = this.bridges.get(entity.namespace);
    if (bridge) {
      bridge.pushEntityToDoc(entity);
    }
  }

  onLocalEntityDelete(entityId: string, namespace: string): void {
    const bridge = this.bridges.get(namespace);
    if (bridge) {
      bridge.deleteEntityFromDoc(entityId);
    }
  }

  onLocalRelationChange(relation: Relation): void {
    const bridge = this.bridges.get(relation.namespace);
    if (bridge) {
      bridge.pushRelationToDoc(relation);
    }
  }

  onLocalRelationDelete(relationId: string, namespace: string): void {
    const bridge = this.bridges.get(namespace);
    if (bridge) {
      bridge.deleteRelationFromDoc(relationId);
    }
  }

  destroy(): void {
    for (const namespace of Array.from(this.bridges.keys())) {
      const bridge = this.bridges.get(namespace);
      bridge?.stopObserving();
    }
    for (const provider of this.providers.values()) {
      provider.destroy();
    }
    for (const doc of this.docs.values()) {
      doc.destroy();
    }
    this.bridges.clear();
    this.providers.clear();
    this.docs.clear();
    this.statuses.clear();
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
