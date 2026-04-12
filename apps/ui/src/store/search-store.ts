import { create } from 'zustand';
import type { SearchResult } from '../lib/types.js';
import { api } from '../lib/api.js';

interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  filters: {
    types?: string;
    namespace?: string;
    minConfidence?: number;
  };

  setQuery: (query: string) => void;
  setFilters: (filters: SearchState['filters']) => void;
  search: () => Promise<void>;
  clear: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  loading: false,
  error: null,
  filters: {},

  setQuery(query) {
    set({ query });
  },

  setFilters(filters) {
    set({ filters });
  },

  async search() {
    const { query, filters } = get();
    if (!query.trim()) {
      set({ results: [] });
      return;
    }
    set({ loading: true, error: null });
    try {
      const results = await api.search({
        q: query,
        types: filters.types,
        namespace: filters.namespace,
        minConfidence: filters.minConfidence,
        limit: 50,
      });
      set({ results, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Search failed' });
    }
  },

  clear() {
    set({ query: '', results: [], error: null });
  },
}));
