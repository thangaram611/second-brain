import { z } from 'zod';
import { ENTITY_TYPES } from './types.js';
import type { Entity, Relation, SyncConflict } from './types.js';

const RELATION_TYPES = [
  'relates_to', 'depends_on', 'implements', 'supersedes',
  'contradicts', 'derived_from', 'authored_by', 'decided_in',
  'uses', 'tests', 'contains', 'co_changes_with', 'preceded_by', 'blocks',
] as const;

/**
 * Zod schemas for WebSocket payloads. Entities/relations arrive as JSON over
 * the socket, so they are parsed at the boundary rather than cast. We keep the
 * entity/relation schemas loose (passthrough) — the discriminant lives in
 * `type`, and downstream code already treats these as the typed shapes from
 * the REST client. We assert the parsed object satisfies the shared interface
 * via `z.ZodType<Entity>` so the schema and the type stay in lockstep.
 */
const EntitySchema: z.ZodType<Entity> = z.looseObject({
  id: z.string(),
  type: z.enum(ENTITY_TYPES),
  name: z.string(),
  namespace: z.string(),
  observations: z.array(z.string()),
  properties: z.record(z.string(), z.unknown()),
  confidence: z.number(),
  eventTime: z.string(),
  ingestTime: z.string(),
  lastAccessedAt: z.string(),
  accessCount: z.number(),
  source: z.looseObject({ type: z.string() }),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RelationSchema: z.ZodType<Relation> = z.looseObject({
  id: z.string(),
  type: z.enum(RELATION_TYPES),
  sourceId: z.string(),
  targetId: z.string(),
  namespace: z.string(),
  properties: z.record(z.string(), z.unknown()),
  confidence: z.number(),
  weight: z.number(),
  bidirectional: z.boolean(),
  source: z.looseObject({ type: z.string() }),
  eventTime: z.string(),
  ingestTime: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const SyncConflictSchema: z.ZodType<SyncConflict> = z.looseObject({
  entityId: z.string(),
  entityName: z.string(),
  field: z.string(),
  localValue: z.unknown(),
  remoteValue: z.unknown(),
  resolvedAt: z.string().nullable(),
});

export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('entity:created'), entity: EntitySchema }),
  z.object({ type: z.literal('entity:updated'), entity: EntitySchema }),
  z.object({ type: z.literal('entity:deleted'), id: z.string() }),
  z.object({ type: z.literal('relation:created'), relation: RelationSchema }),
  z.object({ type: z.literal('relation:deleted'), id: z.string() }),
  z.object({
    type: z.literal('contradiction:resolved'),
    relationId: z.string(),
    winnerId: z.string(),
    loserId: z.string(),
  }),
  z.object({ type: z.literal('contradiction:dismissed'), relationId: z.string() }),
  z.object({ type: z.literal('sync:connected'), namespace: z.string(), peers: z.number() }),
  z.object({ type: z.literal('sync:disconnected'), namespace: z.string() }),
  z.object({ type: z.literal('sync:conflict'), namespace: z.string(), conflict: SyncConflictSchema }),
]);

export type WsEvent = z.infer<typeof WsEventSchema>;

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
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return; // ignore non-JSON frames
    }
    const parsed = WsEventSchema.safeParse(raw);
    if (!parsed.success) return; // ignore malformed / unknown messages
    for (const listener of listeners) {
      listener(parsed.data);
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
