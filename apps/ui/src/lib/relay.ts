import { useAuthStore } from '../store/auth-store.js';

/**
 * Default relay URL used when the server's whoami response does not yet
 * carry a `relayUrl` field. This is used by local open mode where there is
 * no team manifest.
 */
export const DEFAULT_RELAY_URL = 'ws://localhost:7421';

/**
 * Resolve the effective relay URL — prefer the value the server surfaced
 * via /api/auth/whoami (kept in auth-store), fall back to the default.
 */
export function getEffectiveRelayUrl(): string {
  return useAuthStore.getState().relayUrl ?? DEFAULT_RELAY_URL;
}
