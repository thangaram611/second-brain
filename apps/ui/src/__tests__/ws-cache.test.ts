import { describe, it, expect } from 'vitest';
import type { Entity, Relation, SyncStatus, Contradiction } from '../lib/types.js';
import {
  mergeGraphData,
  setGraphData,
  upsertEntity,
  deleteEntity,
  addRelation,
  deleteRelation,
  removeContradiction,
  patchSyncStatus,
  prependConflict,
} from '../lib/ws-cache.js';
import type { GraphData } from '../lib/ws-cache.js';
import type { ParallelWorkConflict } from '../lib/api.js';

const e1: Entity = {
  id: 'ent-1',
  type: 'concept',
  name: 'A',
  observations: [],
  tags: [],
  namespace: 'personal',
  properties: {},
  confidence: 1,
  lastAccessedAt: '2026-01-01T00:00:00.000Z',
  accessCount: 0,
  source: { type: 'manual' },
  eventTime: '2026-01-01T00:00:00.000Z',
  ingestTime: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const e2: Entity = { ...e1, id: 'ent-2', name: 'B' };

const r1: Relation = {
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

describe('graph cache reducers', () => {
  it('setGraphData builds a Map keyed by id and keeps relations', () => {
    const next = setGraphData({ entities: [e1, e2], relations: [r1] });
    expect(next.entities.size).toBe(2);
    expect(next.entities.get('ent-1')).toEqual(e1);
    expect(next.relations).toEqual([r1]);
  });

  it('mergeGraphData accumulates entities and dedupes relations', () => {
    const prev: GraphData = setGraphData({ entities: [e1], relations: [r1] });
    const merged = mergeGraphData(prev, { entities: [e2], relations: [r1] });
    expect(merged.entities.size).toBe(2);
    // r1 already present — must not duplicate.
    expect(merged.relations).toEqual([r1]);
  });

  it('upsertEntity replaces the entity object identity', () => {
    const prev = setGraphData({ entities: [e1], relations: [] });
    const updated = { ...e1, name: 'A-renamed' };
    const next = upsertEntity(prev, updated);
    expect(next.entities.get('ent-1')?.name).toBe('A-renamed');
  });

  it('deleteEntity prunes the entity and its incident relations', () => {
    const prev = setGraphData({ entities: [e1, e2], relations: [r1] });
    const next = deleteEntity(prev, 'ent-1');
    expect(next.entities.has('ent-1')).toBe(false);
    expect(next.relations).toEqual([]);
  });

  it('addRelation appends once and ignores duplicates', () => {
    const prev = setGraphData({ entities: [e1, e2], relations: [] });
    const once = addRelation(prev, r1);
    expect(once.relations).toEqual([r1]);
    const twice = addRelation(once, r1);
    expect(twice.relations).toEqual([r1]);
  });

  it('deleteRelation removes by id', () => {
    const prev = setGraphData({ entities: [e1, e2], relations: [r1] });
    const next = deleteRelation(prev, 'rel-1');
    expect(next.relations).toEqual([]);
  });
});

describe('contradiction cache reducer', () => {
  it('removeContradiction drops the matching relation id', () => {
    const c: Contradiction = {
      relation: { ...r1, type: 'contradicts' },
      entityA: e1,
      entityB: e2,
    };
    expect(removeContradiction([c], 'rel-1')).toEqual([]);
    expect(removeContradiction([c], 'other')).toEqual([c]);
    expect(removeContradiction(undefined, 'rel-1')).toEqual([]);
  });
});

describe('sync status cache reducer', () => {
  const status: SyncStatus = {
    namespace: 'team',
    state: 'disconnected',
    connectedPeers: 0,
    lastSyncedAt: null,
  };

  it('patches the matching namespace only', () => {
    const next = patchSyncStatus([status], 'team', { state: 'connected', connectedPeers: 3 });
    expect(next[0].state).toBe('connected');
    expect(next[0].connectedPeers).toBe(3);
  });

  it('leaves other namespaces untouched', () => {
    const other: SyncStatus = { ...status, namespace: 'other' };
    const next = patchSyncStatus([status, other], 'team', { state: 'connected' });
    expect(next[1]).toEqual(other);
  });
});

describe('parallel-work cache reducer', () => {
  const conflict: ParallelWorkConflict = {
    entityId: 'ent-1',
    entityName: 'AuthModule',
    entityType: 'module',
    namespace: 'project-a',
    actors: ['alice'],
    branches: ['feature/auth'],
  };

  it('prepends and dedupes by entityId', () => {
    const once = prependConflict([], conflict);
    expect(once).toEqual([conflict]);
    const twice = prependConflict(once, { ...conflict, entityName: 'dup' });
    expect(twice).toEqual([conflict]);
  });
});
