import { createServer } from 'node:http';
import {
  getBrain,
  closeBrain,
  getSyncManager,
  closeSyncManager,
  getObservationService,
} from './brain-instance.js';
import { createApp } from './app.js';
import { createWsServer, broadcast } from './ws/ws-server.js';

const PORT = Number(process.env.BRAIN_API_PORT ?? 7430);

const brain = getBrain();
const syncManager = getSyncManager();
const observations = getObservationService();

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

const app = createApp(brain, {
  syncManager,
  observations,
  observeOptions: {
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
