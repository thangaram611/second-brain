import { create } from 'zustand';
import type { TimelineEntry } from '../lib/types.js';
import { api } from '../lib/api.js';

interface TimelineState {
  entries: TimelineEntry[];
  loading: boolean;
  error: string | null;
  filters: {
    from: string;
    to: string;
    types?: string;
    namespace?: string;
  };

  setFilters: (filters: Partial<TimelineState['filters']>) => void;
  fetch: () => Promise<void>;
  clear: () => void;
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function defaultTo(): string {
  return new Date().toISOString();
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,
  filters: {
    from: defaultFrom(),
    to: defaultTo(),
  },

  setFilters(partial) {
    set({ filters: { ...get().filters, ...partial } });
  },

  async fetch() {
    const { filters } = get();
    set({ loading: true, error: null });
    try {
      const entries = await api.timeline({
        from: filters.from,
        to: filters.to,
        types: filters.types,
        namespace: filters.namespace,
        limit: 200,
      });
      set({ entries, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load timeline' });
    }
  },

  clear() {
    set({ entries: [], error: null });
  },
}));
