import { createServer } from 'node:http';
import path from 'node:path';
import type { WebhookSecret } from '@second-brain/collectors';
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
import { UsersService } from './services/users.js';
import type { AuthMode } from './middleware/auth.js';

const PORT = Number(process.env.BRAIN_API_PORT ?? 7430);

// --- Auth bootstrap (PR1) ---
const rawAuthMode = process.env.BRAIN_AUTH_MODE ?? 'open';
const authMode: AuthMode = rawAuthMode === 'pat' ? 'pat' : 'open';
const signingKeys = loadSigningKeys();
if (authMode === 'pat') {
  requireSigningKeys(signingKeys);
  if (process.env.BRAIN_AUTH_TOKEN) {
    console.warn(
      '[second-brain] WARNING: BRAIN_AUTH_TOKEN is set in team mode (BRAIN_AUTH_MODE=pat). ' +
        'Legacy bearer auth will continue to work as an admin fallback; remove the env var ' +
        'after team migration to disable the fallback.',
    );
  }
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
// Format: SECOND_BRAIN_WEBHOOK_SECRET__<provider>__<projectId>=<token>
const webhookSecrets = new Map<string, WebhookSecret>();
for (const [envKey, envValue] of Object.entries(process.env)) {
  const match = envKey.match(/^SECOND_BRAIN_WEBHOOK_SECRET__([a-z]+)__(.+)$/);
  if (match && typeof envValue === 'string' && envValue.length > 0) {
    webhookSecrets.set(`${match[1]}:${match[2]}`, { kind: 'token', value: envValue });
  }
}

// Check for HMAC-style secrets too
for (const [envKey, envValue] of Object.entries(process.env)) {
  const hmacMatch = envKey.match(/^SECOND_BRAIN_WEBHOOK_HMAC__([a-z]+)__(.+)$/);
  if (hmacMatch && typeof envValue === 'string' && envValue.length > 0) {
    webhookSecrets.set(`${hmacMatch[1]}:${hmacMatch[2]}`, { kind: 'hmac', key: envValue });
  }
}

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
    legacyBearerToken: process.env.BRAIN_AUTH_TOKEN ?? null,
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
