import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParallelWorkConflict } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    parallelWork: {
      list: vi.fn(),
    },
  },
}));

import { useWipStore } from '../store/wip-store.js';
import { api } from '../lib/api.js';

const conflict1: ParallelWorkConflict = {
  entityId: 'ent-1',
  entityName: 'AuthModule',
  entityType: 'module',
  namespace: 'project-a',
  actors: ['alice', 'bob'],
  branches: ['feature/auth', 'feature/login'],
};

const conflict2: ParallelWorkConflict = {
  entityId: 'ent-2',
  entityName: 'UserModel',
  entityType: 'schema',
  namespace: 'project-a',
  actors: ['carol'],
  branches: ['feature/user-schema'],
};

const initialState = {
  conflicts: [],
  loading: false,
  error: null,
  lastFetched: null,
};

describe('wip-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWipStore.setState(initialState);
  });

  describe('fetch', () => {
    it('sets loading then populates conflicts on success', async () => {
      vi.mocked(api.parallelWork.list).mockResolvedValue({ conflicts: [conflict1, conflict2] });

      const promise = useWipStore.getState().fetch();
      expect(useWipStore.getState().loading).toBe(true);
      expect(useWipStore.getState().error).toBeNull();

      await promise;

      const state = useWipStore.getState();
      expect(state.loading).toBe(false);
      expect(state.conflicts).toEqual([conflict1, conflict2]);
    });

    it('sets lastFetched timestamp on success', async () => {
      vi.mocked(api.parallelWork.list).mockResolvedValue({ conflicts: [] });

      const before = new Date().toISOString();
      await useWipStore.getState().fetch();
      const after = new Date().toISOString();

      const { lastFetched } = useWipStore.getState();
      expect(lastFetched).not.toBeNull();
      expect(lastFetched! >= before).toBe(true);
      expect(lastFetched! <= after).toBe(true);
    });

    it('sets error on API failure', async () => {
      vi.mocked(api.parallelWork.list).mockRejectedValue(new Error('Server error'));

      await useWipStore.getState().fetch();

      const state = useWipStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe('Server error');
      expect(state.conflicts).toEqual([]);
    });

    it('uses fallback message for non-Error throws', async () => {
      vi.mocked(api.parallelWork.list).mockRejectedValue(42);

      await useWipStore.getState().fetch();

      expect(useWipStore.getState().error).toBe('Failed to load parallel work');
    });
  });

  describe('handleNewAlert', () => {
    it('prepends new conflict to list', () => {
      useWipStore.setState({ conflicts: [conflict1] });

      useWipStore.getState().handleNewAlert(conflict2);

      expect(useWipStore.getState().conflicts).toEqual([conflict2, conflict1]);
    });

    it('ignores duplicate entityId', () => {
      useWipStore.setState({ conflicts: [conflict1] });
      const duplicate = { ...conflict2, entityId: conflict1.entityId };

      useWipStore.getState().handleNewAlert(duplicate);

      expect(useWipStore.getState().conflicts).toEqual([conflict1]);
    });

    it('adds to empty list', () => {
      useWipStore.getState().handleNewAlert(conflict1);

      expect(useWipStore.getState().conflicts).toEqual([conflict1]);
    });
  });
});
