import { createServer } from 'node:http';
import path from 'node:path';
import { GitLabProvider, GitHubProvider } from '@second-brain/collectors';
import {
  getServices,
  closeBrain,
  closeSyncManager,
} from './brain-instance.js';
import { createApp } from './app.js';
import { createWsServer, broadcast } from './ws/ws-server.js';
import {
  loadWiredReposForServer,
  buildProviderNamespaceEntries,
} from './lib/wired-repos-loader.js';
import { startPersonalityScheduler } from './services/personality-scheduler.js';
import { loadSigningKeys, requireSigningKeys } from './lib/signing-keys.js';
import { loadWebhookSecretsFromEnv } from './lib/webhook-secrets.js';
import { UsersService } from './services/users.js';
import type { AuthMode } from './middleware/auth.js';

const PORT = Number(process.env.BRAIN_API_PORT ?? 7430);

// --- Auth bootstrap (PR1) ---
const rawAuthMode = process.env.BRAIN_AUTH_MODE ?? 'open';
const authMode: AuthMode = rawAuthMode === 'pat' ? 'pat' : 'open';
const signingKeys = loadSigningKeys();
if (authMode === 'pat') {
  requireSigningKeys(signingKeys);
}

const usersDbPath =
  process.env.BRAIN_USERS_DB_PATH ?? path.join(process.cwd(), 'users.db');
const usersService = new UsersService({ path: usersDbPath });

const { brain, syncManager, observations, ownership, personality: personalityExtractor } = getServices();

// Phase 10.3 — seed ObservationService with wiredRepos namespace map so
// mr-event deliveries can derive namespace server-side (rev #3).
const wiredConfig = loadWiredReposForServer();
for (const entry of buildProviderNamespaceEntries(wiredConfig)) {
  observations.registerWiredProject(entry.provider, entry.projectId, entry.namespace);
}

// Build webhook-secret map from env (keychain is a CLI-side concern).
const webhookSecrets = loadWebhookSecretsFromEnv();

// Build provider registry for observe routes
const providerRegistry = new Map<string, import('@second-brain/collectors').GitProvider>();
providerRegistry.set('gitlab', new GitLabProvider());
providerRegistry.set('github', new GitHubProvider());

// Wire sync events to WS broadcast
syncManager.onSyncEvent = (event) => {
  broadcast(event);
};

// Run a GC pass once at startup so a long-idle server doesn't accept writes
// on top of stale session namespaces.
try {
  const removed = observations.gcExpiredSessions();
  if (removed > 0) {
    console.log(`[second-brain] gc: removed ${removed} expired session entities`);
  }
} catch (err) {
  console.warn('[second-brain] gc: startup pass failed', err);
}

// --- Personality extraction wiring ---
if (personalityExtractor) {
  observations.setPersonalityExtractor(personalityExtractor);
  startPersonalityScheduler(brain, personalityExtractor);
}

const app = createApp(brain, {
  syncManager,
  observations,
  ownership,
  observeOptions: {
    bearerToken: process.env.BRAIN_AUTH_TOKEN,
    webhookSecrets,
    providerRegistry,
  },
  queryOptions: {
    bearerToken: process.env.BRAIN_AUTH_TOKEN,
  },
  auth: {
    mode: authMode,
    users: usersService,
    inviteSigningKey: signingKeys.inviteSigningKey,
  },
});
const server = createServer(app);

createWsServer(server);

server.listen(PORT, () => {
  console.log(`[second-brain] REST API: http://localhost:${PORT}`);
  console.log(`[second-brain] WebSocket: ws://localhost:${PORT}/ws`);
});

function shutdown() {
  console.log('\n[second-brain] Shutting down...');
  server.close();
  closeSyncManager();
  closeBrain();
  try {
    usersService.close();
  } catch {
    // best-effort
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Last-resort crash handlers ---
// An uncaught exception or unhandled rejection leaves the process in an
// undefined state. Log it (so the failure isn't silent) and exit non-zero so
// the supervisor (systemd Restart=on-failure / launchd KeepAlive) restarts a
// clean process instead of leaving a half-broken server accepting requests.
process.on('uncaughtException', (err) => {
  console.error('[second-brain] uncaughtException — exiting for supervised restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[second-brain] unhandledRejection — exiting for supervised restart:', reason);
  process.exit(1);
});
