import { createServer } from 'node:http';
import { getBrain, closeBrain, getSyncManager, closeSyncManager } from './brain-instance.js';
import { createApp } from './app.js';
import { createWsServer, broadcast } from './ws/ws-server.js';

const PORT = Number(process.env.BRAIN_API_PORT ?? 7430);

const brain = getBrain();
const syncManager = getSyncManager();

// Wire sync events to WS broadcast
syncManager.onSyncEvent = (event) => {
  broadcast(event);
};

const app = createApp(brain, syncManager);
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
