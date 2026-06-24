import { describe, it, expect } from 'vitest';
import { WsEventSchema } from '../lib/ws.js';

const entity = {
  id: 'ent-1',
  type: 'concept',
  name: 'A',
  namespace: 'personal',
  observations: [],
  properties: {},
  confidence: 1,
  eventTime: '2026-01-01T00:00:00.000Z',
  ingestTime: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z',
  accessCount: 0,
  source: { type: 'manual' },
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const relation = {
  id: 'rel-1',
  type: 'depends_on',
  sourceId: 'ent-1',
  targetId: 'ent-2',
  namespace: 'personal',
  properties: {},
  confidence: 1,
  weight: 1,
  bidirectional: false,
  source: { type: 'manual' },
  eventTime: '2026-01-01T00:00:00.000Z',
  ingestTime: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('WsEventSchema', () => {
  it('parses each event variant', () => {
    const samples: unknown[] = [
      { type: 'connected' },
      { type: 'entity:created', entity },
      { type: 'entity:updated', entity },
      { type: 'entity:deleted', id: 'ent-1' },
      { type: 'relation:created', relation },
      { type: 'relation:deleted', id: 'rel-1' },
      { type: 'contradiction:resolved', relationId: 'rel-1', winnerId: 'a', loserId: 'b' },
      { type: 'contradiction:dismissed', relationId: 'rel-1' },
      { type: 'sync:connected', namespace: 'team', peers: 2 },
      { type: 'sync:disconnected', namespace: 'team' },
      {
        type: 'sync:conflict',
        namespace: 'team',
        conflict: {
          entityId: 'ent-1',
          entityName: 'A',
          field: 'name',
          localValue: 'x',
          remoteValue: 'y',
          resolvedAt: null,
        },
      },
    ];
    for (const sample of samples) {
      expect(WsEventSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('rejects unknown event types', () => {
    expect(WsEventSchema.safeParse({ type: 'bogus' }).success).toBe(false);
  });

  it('rejects a malformed entity payload', () => {
    expect(
      WsEventSchema.safeParse({ type: 'entity:created', entity: { id: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects a missing discriminant', () => {
    expect(WsEventSchema.safeParse({ entity }).success).toBe(false);
  });
});
