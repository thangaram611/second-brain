import { Router } from 'express';
import { signRelayToken } from '@second-brain/sync';
import type { SyncManager } from '@second-brain/sync';
import { SyncJoinSchema, SyncLeaveSchema } from '../schemas.js';
import { enforceNamespace, requireScope } from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';
import { paramString } from './helpers.js';

export interface SyncRoutesOptions {
  users?: UsersService | null;
  /**
   * Shared relay secret. The server mints the relay JWT itself so clients never
   * handle it. Defaults to `process.env.RELAY_AUTH_SECRET`; a `brain init
   * server` install loads it from the same EnvironmentFile as the relay. When
   * absent (e.g. a server started without it), `/api/sync/join` returns 503.
   */
  relayAuthSecret?: string;
}

export function syncRoutes(
  syncManager: SyncManager,
  options: SyncRoutesOptions = {},
): Router {
  const router = Router();
  const users = options.users ?? null;
  // Resolved once at boot — the deployment model sets RELAY_AUTH_SECRET in the
  // server's environment before start (via the shared secrets EnvironmentFile).
  const relayAuthSecret = options.relayAuthSecret ?? process.env.RELAY_AUTH_SECRET;

  // GET /api/sync/status — all sync statuses
  router.get('/api/sync/status', (_req, res) => {
    res.json(syncManager.getAllStatuses());
  });

  // GET /api/sync/status/:namespace — status for one namespace
  router.get('/api/sync/status/:namespace', (req, res) => {
    if (!enforceNamespace(req, res, paramString(req.params.namespace), users)) return;
    const status = syncManager.getStatus(paramString(req.params.namespace));
    if (!status) {
      res.status(404).json({ error: 'Namespace not synced' });
      return;
    }
    res.json(status);
  });

  // POST /api/sync/join — join a sync room. The server mints the relay JWT
  // itself (it holds the shared secret), so the client only supplies the
  // namespace + relay URL it discovered from the team manifest.
  router.post('/api/sync/join', requireScope('write', 'admin'), async (req, res) => {
    try {
      const input = SyncJoinSchema.parse(req.body);
      if (!enforceNamespace(req, res, input.namespace, users)) return;
      if (!relayAuthSecret) {
        res.status(503).json({
          error:
            'relay sync is not configured on this server (no RELAY_AUTH_SECRET in its environment)',
        });
        return;
      }
      // Subject identifies this client to the relay for peer awareness. Use the
      // authenticated caller's email when available (PAT/session), else a
      // generic server identity in open mode.
      const token = signRelayToken(relayAuthSecret, {
        sub: req.user?.email ?? 'second-brain-server',
        namespace: input.namespace,
      });
      const status = await syncManager.join({
        namespace: input.namespace,
        relayUrl: input.relayUrl,
        token,
        enabled: true,
      });
      res.json(status);
    } catch (err) {
      if (err instanceof Error && err.message.includes('personal')) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /api/sync/leave — leave a sync room
  router.post('/api/sync/leave', requireScope('write', 'admin'), async (req, res) => {
    const input = SyncLeaveSchema.parse(req.body);
    if (!enforceNamespace(req, res, input.namespace, users)) return;
    await syncManager.leave(input.namespace);
    res.json({ left: input.namespace });
  });

  // GET /api/sync/peers/:namespace — connected peers
  router.get('/api/sync/peers/:namespace', (req, res) => {
    if (!enforceNamespace(req, res, paramString(req.params.namespace), users)) return;
    const peers = syncManager.getPeers(paramString(req.params.namespace));
    res.json(peers);
  });

  return router;
}
