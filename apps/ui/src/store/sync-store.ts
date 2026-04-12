import { create } from 'zustand';
import { api } from '../lib/api.js';
import type { SyncStatus, PeerInfo } from '../lib/types.js';

interface SyncState {
  statuses: SyncStatus[];
  peers: Record<string, PeerInfo[]>;
  loading: boolean;
  error: string | null;

  fetchStatuses: () => Promise<void>;
  fetchPeers: (namespace: string) => Promise<void>;
  joinSync: (config: { namespace: string; relayUrl: string; token: string }) => Promise<void>;
  leaveSync: (namespace: string) => Promise<void>;

  // WebSocket event handlers
  handleSyncConnected: (namespace: string, peers: number) => void;
  handleSyncDisconnected: (namespace: string) => void;
  handlePeerJoined: (namespace: string, peer: PeerInfo) => void;
  handlePeerLeft: (namespace: string, peerId: number) => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  statuses: [],
  peers: {},
  loading: false,
  error: null,

  async fetchStatuses() {
    set({ loading: true, error: null });
    try {
      const statuses = await api.sync.status();
      set({ statuses, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to fetch sync status' });
    }
  },

  async fetchPeers(namespace) {
    try {
      const peerList = await api.sync.peers(namespace);
      set((s) => ({ peers: { ...s.peers, [namespace]: peerList } }));
    } catch {
      // ignore — peers may not be available yet
    }
  },

  async joinSync(config) {
    set({ loading: true, error: null });
    try {
      const status = await api.sync.join(config);
      set((s) => ({
        statuses: [...s.statuses.filter(st => st.namespace !== config.namespace), status],
        loading: false,
      }));
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to join sync' });
    }
  },

  async leaveSync(namespace) {
    set({ loading: true, error: null });
    try {
      await api.sync.leave(namespace);
      set((s) => ({
        statuses: s.statuses.filter(st => st.namespace !== namespace),
        peers: Object.fromEntries(Object.entries(s.peers).filter(([k]) => k !== namespace)),
        loading: false,
      }));
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to leave sync' });
    }
  },

  handleSyncConnected(namespace, peers) {
    set((s) => ({
      statuses: s.statuses.map(st =>
        st.namespace === namespace ? { ...st, state: 'connected' as const, connectedPeers: peers, error: null } : st
      ),
    }));
  },

  handleSyncDisconnected(namespace) {
    set((s) => ({
      statuses: s.statuses.map(st =>
        st.namespace === namespace ? { ...st, state: 'disconnected' as const, connectedPeers: 0 } : st
      ),
    }));
  },

  handlePeerJoined(namespace, peer) {
    set((s) => ({
      peers: {
        ...s.peers,
        [namespace]: [...(s.peers[namespace] ?? []), peer],
      },
      statuses: s.statuses.map(st =>
        st.namespace === namespace ? { ...st, connectedPeers: st.connectedPeers + 1 } : st
      ),
    }));
  },

  handlePeerLeft(namespace, peerId) {
    set((s) => ({
      peers: {
        ...s.peers,
        [namespace]: (s.peers[namespace] ?? []).filter(p => p.clientId !== peerId),
      },
      statuses: s.statuses.map(st =>
        st.namespace === namespace ? { ...st, connectedPeers: Math.max(0, st.connectedPeers - 1) } : st
      ),
    }));
  },
}));
