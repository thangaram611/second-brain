import jwt from 'jsonwebtoken';
import { Hocuspocus } from '@hocuspocus/server';
import type { onAuthenticatePayload, onConnectPayload, onDisconnectPayload, onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server';
import { RelayAuthPayloadSchema } from '@second-brain/types';
import type { RelayAuthPayload } from '@second-brain/types';
import { loadDocState, saveDocState } from './persistence.js';

export interface RelayServerConfig {
  authSecret: string;
  persistDir?: string;
}

/**
 * Verify a relay JWT and return its validated payload.
 *
 * Exported as a pure function so the auth path is testable without standing up
 * a live Hocuspocus WebSocket (the onAuthenticate hook is not invokable post-construction).
 */
export function verifyRelayToken(
  token: string,
  authSecret: string,
  documentName: string,
): RelayAuthPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, authSecret);
  } catch {
    throw new Error('Invalid or expired token');
  }

  const parsed = RelayAuthPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('Token payload does not match expected schema');
  }

  const payload = parsed.data;

  // The namespace in the token must match the document (room) name
  if (payload.namespace !== documentName) {
    throw new Error(
      `Token namespace "${payload.namespace}" does not match document "${documentName}"`,
    );
  }

  return payload;
}

/**
 * Create and configure a Hocuspocus relay server.
 *
 * - Authenticates connections via JWT tokens
 * - Persists Y.Doc state to disk (if persistDir is provided)
 * - Logs connect / disconnect events
 */
export function createRelayServer(config: RelayServerConfig): Hocuspocus {
  const { authSecret, persistDir } = config;

  const hocuspocus = new Hocuspocus({
    quiet: true,

    async onAuthenticate(data: onAuthenticatePayload) {
      // Attach validated payload to context so downstream hooks can use it
      const payload = verifyRelayToken(data.token, authSecret, data.documentName);
      return { user: payload };
    },

    async onConnect(data: onConnectPayload) {
      console.log(
        `[relay] Client connecting to "${data.documentName}" (socket: ${data.socketId})`,
      );
    },

    async onDisconnect(data: onDisconnectPayload) {
      console.log(
        `[relay] Client disconnected from "${data.documentName}" (socket: ${data.socketId}, remaining: ${data.clientsCount})`,
      );
    },

    async onLoadDocument(data: onLoadDocumentPayload) {
      if (persistDir) {
        console.log(`[relay] Loading document "${data.documentName}" from disk`);
        await loadDocState(persistDir, data.documentName, data.document);
      }
    },

    async onStoreDocument(data: onStoreDocumentPayload) {
      if (persistDir) {
        console.log(`[relay] Persisting document "${data.documentName}" to disk`);
        await saveDocState(persistDir, data.documentName, data.document);
      }
    },
  });

  return hocuspocus;
}
