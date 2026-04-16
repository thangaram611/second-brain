import { create } from 'zustand';
import { api } from '../lib/api.js';
import type { ParallelWorkConflict } from '../lib/api.js';

export type { ParallelWorkConflict };

interface WipState {
  conflicts: ParallelWorkConflict[];
  loading: boolean;
  error: string | null;
  lastFetched: string | null;

  fetch: () => Promise<void>;
  handleNewAlert: (conflict: ParallelWorkConflict) => void;
}

export const useWipStore = create<WipState>((set, get) => ({
  conflicts: [],
  loading: false,
  error: null,
  lastFetched: null,

  async fetch() {
    set({ loading: true, error: null });
    try {
      const { conflicts } = await api.parallelWork.list();
      set({ conflicts, loading: false, lastFetched: new Date().toISOString() });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load parallel work' });
    }
  },

  handleNewAlert(conflict) {
    const existing = get().conflicts;
    if (existing.some((c) => c.entityId === conflict.entityId)) return;
    set({ conflicts: [conflict, ...existing] });
  },
}));
