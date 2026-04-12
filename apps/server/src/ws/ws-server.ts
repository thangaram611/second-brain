import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { Entity, Relation, DecayRunResult } from '@second-brain/types';

export type WsEvent =
  | { type: 'entity:created'; entity: Entity }
  | { type: 'entity:updated'; entity: Entity }
  | { type: 'entity:deleted'; id: string }
  | { type: 'relation:created'; relation: Relation }
  | { type: 'relation:deleted'; id: string }
  | { type: 'contradiction:resolved'; relationId: string; winnerId: string; loserId: string }
  | { type: 'contradiction:dismissed'; relationId: string }
  | { type: 'decay:run'; result: DecayRunResult };

let wss: WebSocketServer | null = null;

export function createWsServer(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected' }));

    // Heartbeat
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on('close', () => clearInterval(interval));
  });

  return wss;
}

export function broadcast(event: WsEvent): void {
  if (!wss) return;
  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
