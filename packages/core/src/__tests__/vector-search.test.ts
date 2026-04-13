import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import { VectorSearchChannel } from '../search/vector-channel.js';

let brain: Brain;
const DIM = 4;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false, vectorDimensions: DIM });
});

afterEach(() => {
  brain.close();
});

/**
 * Deterministic fake embedder: produces a unit vector pointing in the
 * direction implied by the first letter of the query. Lets us assert
 * KNN ordering without an LLM.
 */
function fakeEmbedder(map: Record<string, number[]>) {
  return async (query: string): Promise<Float32Array> => {
    const key = query.trim().toLowerCase();
    return Float32Array.from(map[key] ?? [0, 0, 0, 0]);
  };
}

describe('VectorSearchChannel + searchMulti', () => {
  it('multi-channel fuses fulltext and vector via RRF', async () => {
    const crdt = brain.entities.create({
      type: 'concept',
      name: 'CRDT',
      observations: ['conflict-free replicated data type'],
      source: { type: 'manual' },
    });
    const yjs = brain.entities.create({
      type: 'tool',
      name: 'Yjs',
      observations: ['popular CRDT library'],
      source: { type: 'manual' },
    });
    const sqlite = brain.entities.create({
      type: 'tool',
      name: 'SQLite',
      observations: ['embedded SQL database'],
      source: { type: 'manual' },
    });

    // Embeddings: place CRDT and Yjs near each other; SQLite far.
    brain.embeddings!.upsert(crdt.id, Float32Array.from([1, 0, 0, 0]), 'fake', 'h-c');
    brain.embeddings!.upsert(yjs.id, Float32Array.from([0.95, 0.05, 0, 0]), 'fake', 'h-y');
    brain.embeddings!.upsert(sqlite.id, Float32Array.from([0, 0, 1, 0]), 'fake', 'h-s');

    const channel = new VectorSearchChannel(
      brain.embeddings!,
      brain.entities,
      fakeEmbedder({ crdt: [1, 0, 0, 0] }),
    );
    brain.search.setVectorChannel(channel);

    // FTS surfaces CRDT (name) and Yjs (observation); vector also surfaces both.
    const fused = await brain.search.searchMulti({ query: 'CRDT', limit: 5 });
    const ids = fused.map((r) => r.entity.id);

    // Both CRDT and Yjs must appear in the top results — fusion combined channels.
    expect(ids.slice(0, 2)).toContain(crdt.id);
    expect(ids.slice(0, 2)).toContain(yjs.id);
    // SQLite is irrelevant in both channels and should rank below or be absent.
    if (ids.includes(sqlite.id)) {
      expect(ids.indexOf(sqlite.id)).toBeGreaterThan(1);
    }
  });

  it('searchMulti falls back to fulltext-only when no vector channel set', async () => {
    brain.entities.create({
      type: 'concept',
      name: 'Vector',
      observations: ['linear algebra'],
      source: { type: 'manual' },
    });
    expect(brain.search.hasVectorChannel()).toBe(false);

    const results = await brain.search.searchMulti({ query: 'vector' });
    expect(results.length).toBe(1);
    expect(results[0].matchChannel).toBe('fulltext');
  });

  it('respects explicit channels filter', async () => {
    const e = brain.entities.create({
      type: 'concept',
      name: 'Alpha',
      source: { type: 'manual' },
    });
    brain.embeddings!.upsert(e.id, Float32Array.from([1, 0, 0, 0]), 'fake', 'h');

    const channel = new VectorSearchChannel(
      brain.embeddings!,
      brain.entities,
      fakeEmbedder({ alpha: [1, 0, 0, 0] }),
    );
    brain.search.setVectorChannel(channel);

    // vector-only request bypasses fulltext.
    const vec = await brain.search.searchMulti({ query: 'Alpha', channels: ['vector'] });
    expect(vec[0].matchChannel).toBe('vector');

    // fulltext-only request bypasses vector.
    const fts = await brain.search.searchMulti({ query: 'Alpha', channels: ['fulltext'] });
    expect(fts[0].matchChannel).toBe('fulltext');
  });

  it('vector channel tolerates entities deleted between embedding and search', async () => {
    const e = brain.entities.create({ type: 'concept', name: 'Ghost', source: { type: 'manual' } });
    brain.embeddings!.upsert(e.id, Float32Array.from([1, 0, 0, 0]), 'fake', 'h');
    brain.entities.delete(e.id);

    const channel = new VectorSearchChannel(
      brain.embeddings!,
      brain.entities,
      fakeEmbedder({ ghost: [1, 0, 0, 0] }),
    );
    const results = await channel.search({ query: 'Ghost', limit: 5 });
    // Entity gone → channel should silently skip rather than throw.
    expect(results.length).toBe(0);
  });

  it('synchronous search() is unchanged (zero breakage check)', () => {
    brain.entities.create({
      type: 'concept',
      name: 'Sync',
      observations: ['stays synchronous forever'],
      source: { type: 'manual' },
    });
    const results = brain.search.search({ query: 'sync' });
    expect(results.length).toBe(1);
    expect(results[0].matchChannel).toBe('fulltext');
  });
});
