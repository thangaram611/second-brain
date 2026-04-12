import { create } from 'zustand';
import type { Contradiction } from '../lib/types.js';
import { api } from '../lib/api.js';

interface ContradictionsState {
  contradictions: Contradiction[];
  loading: boolean;
  error: string | null;
  resolving: string | null;

  fetch: () => Promise<void>;
  resolve: (relationId: string, winnerId: string) => Promise<void>;
  dismiss: (relationId: string) => Promise<void>;
  handleContradictionResolved: (relationId: string) => void;
  handleContradictionDismissed: (relationId: string) => void;
}

export const useContradictionsStore = create<ContradictionsState>((set, get) => ({
  contradictions: [],
  loading: false,
  error: null,
  resolving: null,

  async fetch() {
    set({ loading: true, error: null });
    try {
      const contradictions = await api.contradictions.list();
      set({ contradictions, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load contradictions' });
    }
  },

  async resolve(relationId, winnerId) {
    set({ resolving: relationId });
    try {
      await api.contradictions.resolve(relationId, winnerId);
      // Optimistically remove from list
      set({
        contradictions: get().contradictions.filter((c) => c.relation.id !== relationId),
        resolving: null,
      });
    } catch (e) {
      set({ resolving: null, error: e instanceof Error ? e.message : 'Failed to resolve' });
    }
  },

  async dismiss(relationId) {
    set({ resolving: relationId });
    try {
      await api.contradictions.dismiss(relationId);
      set({
        contradictions: get().contradictions.filter((c) => c.relation.id !== relationId),
        resolving: null,
      });
    } catch (e) {
      set({ resolving: null, error: e instanceof Error ? e.message : 'Failed to dismiss' });
    }
  },

  handleContradictionResolved(relationId) {
    set({
      contradictions: get().contradictions.filter((c) => c.relation.id !== relationId),
    });
  },

  handleContradictionDismissed(relationId) {
    set({
      contradictions: get().contradictions.filter((c) => c.relation.id !== relationId),
    });
  },
}));
