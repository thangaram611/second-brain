import { create } from 'zustand';
import { api } from '../lib/api.js';

export interface OwnershipNode {
  path: string;
  name: string;
  isDir: boolean;
  owners?: Array<{ actor: string; score: number }>;
  children?: OwnershipNode[];
}

interface OwnershipState {
  tree: OwnershipNode | null;
  selectedPath: string;
  loading: boolean;
  error: string | null;
  breadcrumbs: string[];

  fetchTree: (path?: string) => Promise<void>;
  selectPath: (path: string) => void;
  navigateTo: (path: string) => void;
}

export const useOwnershipStore = create<OwnershipState>((set) => ({
  tree: null,
  selectedPath: '.',
  loading: false,
  error: null,
  breadcrumbs: ['.'],

  async fetchTree(path = '.') {
    set({ loading: true, error: null });
    try {
      const tree = await api.ownership.tree(path);
      set({ tree, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load ownership tree' });
    }
  },

  selectPath(path: string) {
    set({ selectedPath: path });
  },

  navigateTo(path: string) {
    const segments = path === '.' ? ['.'] : ['.', ...path.split('/')];
    set({ selectedPath: path, breadcrumbs: segments });
    // fetch is called after state update
    const store = useOwnershipStore.getState();
    store.fetchTree(path);
  },
}));
