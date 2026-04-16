import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { WebhookSecret } from '@second-brain/collectors';
import {
  getBrain,
  closeBrain,
  getSyncManager,
  closeSyncManager,
  getObservationService,
  getOwnershipService,
  getPersonalityExtractor,
} from './brain-instance.js';
import { createApp } from './app.js';
import { createWsServer, broadcast } from './ws/ws-server.js';
import {
  loadWiredReposForServer,
  buildProviderNamespaceEntries,
} from './lib/wired-repos-loader.js';

const PORT = Number(process.env.BRAIN_API_PORT ?? 7430);

const brain = getBrain();
const syncManager = getSyncManager();
const observations = getObservationService();
const ownership = getOwnershipService();

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
const personalityExtractor = getPersonalityExtractor();
if (personalityExtractor) {
  observations.setPersonalityExtractor(personalityExtractor);
}

// Personality recurring scheduler with restart-recovery
if (personalityExtractor) {
  const CONFIG_PATH = join(homedir(), '.second-brain', 'config.json');
  const INTERVAL_MS = Number(process.env.PERSONALITY_EXTRACT_INTERVAL_MS ?? 86_400_000); // 24h
  const BOOT_DELAY_MS = 10 * 60 * 1000; // 10 min after boot

  function readLastRunAt(): string | null {
    try {
      if (!existsSync(CONFIG_PATH)) return null;
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      return (config.personality as Record<string, unknown>)?.lastRunAt as string ?? null;
    } catch {
      return null;
    }
  }

  function writeLastRunAt(iso: string): void {
    try {
      const dir = dirname(CONFIG_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let config: Record<string, unknown> = {};
      if (existsSync(CONFIG_PATH)) {
        config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      }
      if (!config.personality) config.personality = {};
      (config.personality as Record<string, unknown>).lastRunAt = iso;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
      console.warn('[second-brain] failed to write personality lastRunAt:', err);
    }
  }

  async function runPersonalityExtraction(): Promise<void> {
    try {
      const actors = brain.storage.sqlite
        .prepare(
          `SELECT DISTINCT source_actor FROM entities WHERE source_actor IS NOT NULL LIMIT 20`,
        )
        .all() as Array<{ source_actor: string }>;

      for (const row of actors) {
        await personalityExtractor!.run(row.source_actor);
      }
      writeLastRunAt(new Date().toISOString());
    } catch (err) {
      console.warn('[second-brain] nightly personality extraction error:', err);
    }
  }

  function scheduleNext(): void {
    const lastRun = readLastRunAt();
    const now = Date.now();
    let nextDue: number;

    if (lastRun) {
      nextDue = new Date(lastRun).getTime() + INTERVAL_MS;
      if (nextDue <= now) {
        nextDue = now + BOOT_DELAY_MS;
      }
    } else {
      nextDue = now + BOOT_DELAY_MS;
    }

    const delayMs = Math.max(nextDue - now, BOOT_DELAY_MS);
    setTimeout(async () => {
      await runPersonalityExtraction();
      scheduleNext();
    }, delayMs);

    console.log(`[second-brain] personality extraction scheduled in ${Math.round(delayMs / 1000)}s`);
  }

  scheduleNext();
}

const app = createApp(brain, {
  syncManager,
  observations,
  ownership,
  observeOptions: {
    bearerToken: process.env.BRAIN_AUTH_TOKEN,
    webhookSecrets,
  },
  queryOptions: {
    bearerToken: process.env.BRAIN_AUTH_TOKEN,
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
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
