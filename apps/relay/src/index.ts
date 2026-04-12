import { createServer } from 'node:http';
import { homedir } from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createRelayServer } from './server.js';
import { createAuthRouter } from './auth.js';

// --- Configuration from environment ---

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 7421);
const AUTH_SECRET = process.env.RELAY_AUTH_SECRET;

if (!AUTH_SECRET) {
  console.error('[relay] RELAY_AUTH_SECRET environment variable is required');
  process.exit(1);
}

const PERSIST_DIR = process.env.RELAY_PERSIST_DIR
  ?? path.join(homedir(), '.second-brain', 'relay');

// --- Express app for HTTP endpoints ---

const app = express();
app.use(express.json());
app.use(createAuthRouter(AUTH_SECRET));
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Hocuspocus relay server ---

const hocuspocus = createRelayServer({
  authSecret: AUTH_SECRET,
  persistDir: PERSIST_DIR,
});

// --- HTTP server ---

const httpServer = createServer(app);

// --- WebSocket upgrade handling ---
// Hocuspocus expects raw WebSocket connections via `handleConnection`.
// We create a `noServer` WebSocketServer, handle the HTTP upgrade ourselves,
// and forward established sockets to Hocuspocus.

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    hocuspocus.handleConnection(ws, request);
  });
});

// --- Start listening ---

httpServer.listen(RELAY_PORT, () => {
  console.log(`[relay] HTTP + Auth:  http://localhost:${RELAY_PORT}`);
  console.log(`[relay] WebSocket:    ws://localhost:${RELAY_PORT}`);
  console.log(`[relay] Health check: http://localhost:${RELAY_PORT}/health`);
  console.log(`[relay] Persist dir:  ${PERSIST_DIR}`);
});

// --- Graceful shutdown ---

function shutdown() {
  console.log('\n[relay] Shutting down...');
  httpServer.close();
  void hocuspocus.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
