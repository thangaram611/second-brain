import { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import type { SyncConfig } from '@second-brain/types';

export interface SyncProviderCallbacks {
  onConnect: () => void;
  onDisconnect: () => void;
  onSynced: () => void;
  onAwarenessUpdate: (states: Map<number, Record<string, unknown>>) => void;
}

/**
 * Creates a HocuspocusProvider wired up to the relay for a given
 * namespace. Awareness state is initialized with basic user info.
 */
export function createSyncProvider(
  doc: Y.Doc,
  config: SyncConfig,
  callbacks: SyncProviderCallbacks,
): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: config.relayUrl,
    name: config.namespace,
    document: doc,
    token: config.token,
    onConnect: () => {
      callbacks.onConnect();
    },
    onClose: () => {
      callbacks.onDisconnect();
    },
    onSynced: () => {
      callbacks.onSynced();
    },
    onAwarenessUpdate: ({ states }) => {
      // states is a StatesArray (array of { clientId: number, ...rest })
      const stateMap = new Map<number, Record<string, unknown>>();
      for (const state of states) {
        const { clientId, ...rest } = state;
        stateMap.set(clientId, rest);
      }
      callbacks.onAwarenessUpdate(stateMap);
    },
  });

  // Set local awareness state
  provider.setAwarenessField('user', {
    name: `peer-${doc.clientID}`,
    color: generateColor(doc.clientID),
    connectedAt: new Date().toISOString(),
  });

  return provider;
}

/**
 * Simple deterministic color from clientID.
 */
function generateColor(clientId: number): string {
  const hue = clientId % 360;
  return `hsl(${hue}, 70%, 50%)`;
}
