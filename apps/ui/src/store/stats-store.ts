import { create } from 'zustand';
import type { GraphStats } from '../lib/types.js';
import { api } from '../lib/api.js';

interface StatsState {
  stats: GraphStats | null;
  loading: boolean;
  error: string | null;
  fetchStats: (namespace?: string) => Promise<void>;
}

export const useStatsStore = create<StatsState>((set) => ({
  stats: null,
  loading: false,
  error: null,

  async fetchStats(namespace) {
    set({ loading: true, error: null });
    try {
      const stats = await api.stats(namespace);
      set({ stats, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load stats' });
    }
  },
}));
