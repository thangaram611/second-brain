import jwt from 'jsonwebtoken';
import { RELAY_PERMISSIONS } from '@second-brain/types';
import type { RelayAuthPayload } from '@second-brain/types';

/** Default relay token lifetime — matches the relay's verification window. */
const DEFAULT_TOKEN_EXPIRY_SECONDS = 86_400; // 24h

export interface SignRelayTokenOptions {
  /** Token subject — identity of the joining client (e.g. the user's email). */
  sub: string;
  /** Namespace (sync room) the token grants access to. */
  namespace: string;
  /** Lifetime in seconds. Defaults to 24h. */
  expiresInSeconds?: number;
}

/**
 * Mint a relay auth JWT, signed with the shared relay secret — the server-side
 * counterpart to the relay's `verifyRelayToken`.
 *
 * The server holds `RELAY_AUTH_SECRET` (the same secret the relay verifies
 * with) and mints tokens on behalf of already-authenticated clients, so the
 * shared secret never has to be distributed to sync clients. `iat`/`exp` are
 * injected by `jwt.sign` via `expiresIn`.
 */
export function signRelayToken(authSecret: string, options: SignRelayTokenOptions): string {
  const payload: Omit<RelayAuthPayload, 'iat' | 'exp'> = {
    sub: options.sub,
    namespace: options.namespace,
    permissions: [...RELAY_PERMISSIONS],
  };
  return jwt.sign(payload, authSecret, {
    expiresIn: options.expiresInSeconds ?? DEFAULT_TOKEN_EXPIRY_SECONDS,
  });
}
