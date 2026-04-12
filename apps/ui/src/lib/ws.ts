import type { Entity, Relation } from './types.js';

export type WsEvent =
  | { type: 'connected' }
  | { type: 'entity:created'; entity: Entity }
  | { type: 'entity:updated'; entity: Entity }
  | { type: 'entity:deleted'; id: string }
  | { type: 'relation:created'; relation: Relation }
  | { type: 'relation:deleted'; id: string };

type WsListener = (event: WsEvent) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const listeners = new Set<WsListener>();

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect() {
  if (socket?.readyState === WebSocket.OPEN) return;

  socket = new WebSocket(getWsUrl());

  socket.onopen = () => {
    reconnectDelay = 1000;
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as WsEvent;
      for (const listener of listeners) {
        listener(data);
      }
    } catch {
      // ignore malformed messages
    }
  };

  socket.onclose = () => {
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    connect();
  }, reconnectDelay);
}

export function subscribe(listener: WsListener): () => void {
  listeners.add(listener);
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  socket?.close();
  socket = null;
}
