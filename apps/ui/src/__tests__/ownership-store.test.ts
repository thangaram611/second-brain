import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OwnershipNode } from '../store/ownership-store.js';

vi.mock('../lib/api.js', () => ({
  api: {
    ownership: {
      tree: vi.fn(),
    },
  },
}));

import { useOwnershipStore } from '../store/ownership-store.js';
import { api } from '../lib/api.js';

const mockTree: OwnershipNode = {
  path: '.',
  name: '.',
  isDir: true,
  owners: [{ actor: 'alice', score: 0.8 }],
  children: [
    { path: 'src', name: 'src', isDir: true, owners: [{ actor: 'bob', score: 0.6 }] },
    { path: 'README.md', name: 'README.md', isDir: false, owners: [{ actor: 'alice', score: 1.0 }] },
  ],
};

const initialState = {
  tree: null,
  selectedPath: '.',
  loading: false,
  error: null,
  breadcrumbs: ['.'],
};

describe('ownership-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOwnershipStore.setState(initialState);
  });

  describe('fetchTree', () => {
    it('sets loading then populates tree on success', async () => {
      vi.mocked(api.ownership.tree).mockResolvedValue(mockTree);

      const promise = useOwnershipStore.getState().fetchTree();
      expect(useOwnershipStore.getState().loading).toBe(true);
      expect(useOwnershipStore.getState().error).toBeNull();

      await promise;

      const state = useOwnershipStore.getState();
      expect(state.loading).toBe(false);
      expect(state.tree).toEqual(mockTree);
      expect(api.ownership.tree).toHaveBeenCalledWith('.');
    });

    it('passes custom path to API', async () => {
      vi.mocked(api.ownership.tree).mockResolvedValue(mockTree);

      await useOwnershipStore.getState().fetchTree('src');

      expect(api.ownership.tree).toHaveBeenCalledWith('src');
    });

    it('sets error on API failure', async () => {
      vi.mocked(api.ownership.tree).mockRejectedValue(new Error('Network error'));

      await useOwnershipStore.getState().fetchTree();

      const state = useOwnershipStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe('Network error');
      expect(state.tree).toBeNull();
    });

    it('uses fallback message for non-Error throws', async () => {
      vi.mocked(api.ownership.tree).mockRejectedValue('something');

      await useOwnershipStore.getState().fetchTree();

      expect(useOwnershipStore.getState().error).toBe('Failed to load ownership tree');
    });
  });

  describe('selectPath', () => {
    it('updates selectedPath', () => {
      useOwnershipStore.getState().selectPath('src/index.ts');

      expect(useOwnershipStore.getState().selectedPath).toBe('src/index.ts');
    });

    it('does not affect breadcrumbs or tree', () => {
      useOwnershipStore.setState({ breadcrumbs: ['.'], tree: mockTree });

      useOwnershipStore.getState().selectPath('src');

      const state = useOwnershipStore.getState();
      expect(state.breadcrumbs).toEqual(['.']);
      expect(state.tree).toEqual(mockTree);
    });
  });

  describe('navigateTo', () => {
    it('updates selectedPath, breadcrumbs, and fetches tree', async () => {
      vi.mocked(api.ownership.tree).mockResolvedValue(mockTree);

      useOwnershipStore.getState().navigateTo('src/lib');

      const state = useOwnershipStore.getState();
      expect(state.selectedPath).toBe('src/lib');
      expect(state.breadcrumbs).toEqual(['.', 'src', 'lib']);
      expect(api.ownership.tree).toHaveBeenCalledWith('src/lib');
    });

    it('handles root path navigation', async () => {
      vi.mocked(api.ownership.tree).mockResolvedValue(mockTree);

      useOwnershipStore.getState().navigateTo('.');

      const state = useOwnershipStore.getState();
      expect(state.selectedPath).toBe('.');
      expect(state.breadcrumbs).toEqual(['.']);
      expect(api.ownership.tree).toHaveBeenCalledWith('.');
    });
  });
});
