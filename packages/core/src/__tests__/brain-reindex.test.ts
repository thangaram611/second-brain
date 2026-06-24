import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';

describe('Brain.reindex', () => {
  let brain: Brain;

  beforeEach(() => {
    brain = new Brain({ path: ':memory:', wal: false });
  });

  afterEach(() => {
    brain.close();
  });

  it('rebuilds the FTS index without error and search still works', () => {
    brain.entities.create({
      type: 'concept',
      name: 'CRDT',
      observations: ['Conflict-free Replicated Data Types'],
      source: { type: 'manual' },
    });

    expect(brain.search.search({ query: 'CRDT' })).toHaveLength(1);

    expect(() => brain.reindex()).not.toThrow();

    const results = brain.search.search({ query: 'CRDT' });
    expect(results).toHaveLength(1);
    expect(results[0].entity.name).toBe('CRDT');
  });
});

describe('Brain.attachVectorChannel', () => {
  let brain: Brain;
  const DIM = 4;

  afterEach(() => {
    brain.close();
  });

  const stubEmbedder = async (): Promise<Float32Array> => Float32Array.from([1, 0, 0, 0]);

  it('returns false when vector search is not enabled', () => {
    brain = new Brain({ path: ':memory:', wal: false });
    expect(brain.attachVectorChannel(stubEmbedder)).toBe(false);
    expect(brain.search.hasVectorChannel()).toBe(false);
  });

  it('attaches a channel once and is idempotent', () => {
    brain = new Brain({ path: ':memory:', wal: false, vectorDimensions: DIM });
    const e = brain.entities.create({ type: 'concept', name: 'Alpha', source: { type: 'manual' } });
    brain.embeddings!.upsert(e.id, Float32Array.from([1, 0, 0, 0]), 'fake', 'h');

    expect(brain.attachVectorChannel(stubEmbedder)).toBe(true);
    expect(brain.search.hasVectorChannel()).toBe(true);

    // Second call is a no-op: a channel is already wired.
    expect(brain.attachVectorChannel(stubEmbedder)).toBe(false);
    expect(brain.search.hasVectorChannel()).toBe(true);
  });
});
