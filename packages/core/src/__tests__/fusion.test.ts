import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../search/fusion.js';
import type { RankedResult } from '../search/fusion.js';
import type { Entity } from '@second-brain/types';

function fakeEntity(id: string, name: string): Entity {
  return {
    id,
    type: 'concept',
    name,
    namespace: 'personal',
    observations: [],
    properties: {},
    confidence: 1.0,
    eventTime: '2024-01-01T00:00:00Z',
    ingestTime: '2024-01-01T00:00:00Z',
    lastAccessedAt: '2024-01-01T00:00:00Z',
    accessCount: 0,
    source: { type: 'manual' },
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

describe('reciprocalRankFusion', () => {
  it('returns empty for empty input', () => {
    const results = reciprocalRankFusion([]);
    expect(results).toHaveLength(0);
  });

  it('returns single-channel results in order', () => {
    const entityA = fakeEntity('a', 'A');
    const entityB = fakeEntity('b', 'B');

    const list: RankedResult[] = [
      { entityId: 'a', entity: entityA, rank: 1, channel: 'fulltext', channelScore: 0.9 },
      { entityId: 'b', entity: entityB, rank: 2, channel: 'fulltext', channelScore: 0.8 },
    ];

    const results = reciprocalRankFusion([list]);
    expect(results).toHaveLength(2);
    expect(results[0].entity.id).toBe('a');
    expect(results[1].entity.id).toBe('b');
    // Score = 1/(60+1) ≈ 0.01639
    expect(results[0].score).toBeCloseTo(1 / 61, 5);
  });

  it('boosts entities appearing in multiple channels', () => {
    const entityA = fakeEntity('a', 'A');
    const entityB = fakeEntity('b', 'B');
    const entityC = fakeEntity('c', 'C');

    const fts: RankedResult[] = [
      { entityId: 'a', entity: entityA, rank: 1, channel: 'fulltext', channelScore: 0.9 },
      { entityId: 'b', entity: entityB, rank: 2, channel: 'fulltext', channelScore: 0.8 },
    ];

    const vec: RankedResult[] = [
      { entityId: 'b', entity: entityB, rank: 1, channel: 'vector', channelScore: 0.95 },
      { entityId: 'c', entity: entityC, rank: 2, channel: 'vector', channelScore: 0.7 },
    ];

    const results = reciprocalRankFusion([fts, vec]);

    // B appears in both channels: 1/(60+2) + 1/(60+1) > A's 1/(60+1) alone
    expect(results[0].entity.id).toBe('b');
    expect(results[0].score).toBeCloseTo(1 / 62 + 1 / 61, 5);
  });

  it('handles entities in only one channel', () => {
    const entityA = fakeEntity('a', 'A');

    const list: RankedResult[] = [
      { entityId: 'a', entity: entityA, rank: 1, channel: 'graph', channelScore: 0.5 },
    ];

    const results = reciprocalRankFusion([list]);
    expect(results).toHaveLength(1);
    expect(results[0].matchChannel).toBe('graph');
  });
});
