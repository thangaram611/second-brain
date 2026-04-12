import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { Hocuspocus } from '@hocuspocus/server';
import type { onAuthenticatePayload, onConnectPayload, onDisconnectPayload, onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server';
import { loadDocState, saveDocState } from './persistence.js';

/**
 * Zod schema matching the RelayAuthPayload interface from @second-brain/types.
 * Used to validate JWT payloads without `as` casts.
 */
const RelayAuthPayloadSchema = z.object({
  sub: z.string(),
  namespace: z.string(),
  permissions: z.array(z.enum(['read', 'write'])),
  iat: z.number(),
  exp: z.number(),
});

export interface RelayServerConfig {
  authSecret: string;
  persistDir?: string;
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
      const { token, documentName } = data;

      // Verify JWT signature and expiration
      let decoded: unknown;
      try {
        decoded = jwt.verify(token, authSecret);
      } catch {
        throw new Error('Invalid or expired token');
      }

      // Validate the decoded payload structure with Zod
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

      // Attach validated payload to context so downstream hooks can use it
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
        loadDocState(persistDir, data.documentName, data.document);
      }
    },

    async onStoreDocument(data: onStoreDocumentPayload) {
      if (persistDir) {
        console.log(`[relay] Persisting document "${data.documentName}" to disk`);
        saveDocState(persistDir, data.documentName, data.document);
      }
    },
  });

  return hocuspocus;
}
