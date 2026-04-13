import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';

let brain: Brain;
const DIM = 4;

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false, vectorDimensions: DIM });
});

afterEach(() => {
  brain.close();
});

describe('EmbeddingStore', () => {
  it('initializes vector search and exposes the store', () => {
    expect(brain.embeddings).not.toBeNull();
    expect(brain.storage.vectorDimensions).toBe(DIM);
  });

  it('upserts and retrieves embedding metadata', () => {
    const e = brain.entities.create({
      type: 'concept',
      name: 'CRDT',
      source: { type: 'manual' },
    });
    brain.embeddings!.upsert(e.id, vec([1, 0, 0, 0]), 'test-model', 'hash-v1');
    const meta = brain.embeddings!.getMeta(e.id);
    expect(meta).not.toBeNull();
    expect(meta?.model).toBe('test-model');
    expect(meta?.contentHash).toBe('hash-v1');
  });

  it('rejects vectors with wrong dimensions', () => {
    const e = brain.entities.create({
      type: 'concept',
      name: 'X',
      source: { type: 'manual' },
    });
    expect(() => brain.embeddings!.upsert(e.id, vec([1, 0, 0]), 'm', 'h')).toThrow(/dimension/);
  });

  it('findStale returns ids missing or with changed hash', () => {
    const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
    const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
    const c = brain.entities.create({ type: 'concept', name: 'C', source: { type: 'manual' } });

    brain.embeddings!.upsert(a.id, vec([1, 0, 0, 0]), 'm', 'hash-A');
    brain.embeddings!.upsert(b.id, vec([0, 1, 0, 0]), 'm', 'hash-B');
    // c is never embedded.

    const stale = brain.embeddings!.findStale([
      { id: a.id, contentHash: 'hash-A' }, // up-to-date
      { id: b.id, contentHash: 'hash-B-NEW' }, // changed
      { id: c.id, contentHash: 'hash-C' }, // missing
    ]);
    expect(stale.sort()).toEqual([b.id, c.id].sort());
  });

  it('knnSearch returns nearest neighbors by cosine distance', () => {
    const ids = ['A', 'B', 'C', 'D'].map((name) =>
      brain.entities.create({ type: 'concept', name, source: { type: 'manual' } }).id,
    );

    brain.embeddings!.upsert(ids[0], vec([1, 0, 0, 0]), 'm', 'h0');
    brain.embeddings!.upsert(ids[1], vec([0.9, 0.1, 0, 0]), 'm', 'h1');
    brain.embeddings!.upsert(ids[2], vec([0, 1, 0, 0]), 'm', 'h2');
    brain.embeddings!.upsert(ids[3], vec([0, 0, 1, 0]), 'm', 'h3');

    const hits = brain.embeddings!.knnSearch(vec([1, 0, 0, 0]), 2);
    expect(hits.length).toBe(2);
    // Closest two should be ids[0] (exact) and ids[1] (close).
    expect(hits.map((h) => h.entityId)).toEqual([ids[0], ids[1]]);
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  });

  it('knnSearch filters by namespace', () => {
    const personal = brain.entities.create({
      type: 'concept',
      name: 'P',
      namespace: 'personal',
      source: { type: 'manual' },
    });
    const proj = brain.entities.create({
      type: 'concept',
      name: 'Q',
      namespace: 'project-x',
      source: { type: 'manual' },
    });
    brain.embeddings!.upsert(personal.id, vec([1, 0, 0, 0]), 'm', 'h-p');
    brain.embeddings!.upsert(proj.id, vec([1, 0, 0, 0]), 'm', 'h-q');

    const hits = brain.embeddings!.knnSearch(vec([1, 0, 0, 0]), 5, { namespace: 'project-x' });
    expect(hits.map((h) => h.entityId)).toEqual([proj.id]);
  });

  it('knnSearch filters by entity types', () => {
    const conceptId = brain.entities.create({ type: 'concept', name: 'C', source: { type: 'manual' } }).id;
    const factId = brain.entities.create({ type: 'fact', name: 'F', source: { type: 'manual' } }).id;
    brain.embeddings!.upsert(conceptId, vec([1, 0, 0, 0]), 'm', 'h-c');
    brain.embeddings!.upsert(factId, vec([1, 0, 0, 0]), 'm', 'h-f');

    const hits = brain.embeddings!.knnSearch(vec([1, 0, 0, 0]), 5, { types: ['fact'] });
    expect(hits.map((h) => h.entityId)).toEqual([factId]);
  });

  it('upsert replaces existing embedding (idempotent)', () => {
    const e = brain.entities.create({ type: 'concept', name: 'E', source: { type: 'manual' } });
    brain.embeddings!.upsert(e.id, vec([1, 0, 0, 0]), 'm', 'h1');
    brain.embeddings!.upsert(e.id, vec([0, 1, 0, 0]), 'm', 'h2');

    expect(brain.embeddings!.getMeta(e.id)?.contentHash).toBe('h2');

    // KNN should reflect the new vector.
    const hits = brain.embeddings!.knnSearch(vec([0, 1, 0, 0]), 1);
    expect(hits[0].entityId).toBe(e.id);
  });

  it('delete removes from both tables', () => {
    const e = brain.entities.create({ type: 'concept', name: 'E', source: { type: 'manual' } });
    brain.embeddings!.upsert(e.id, vec([1, 0, 0, 0]), 'm', 'h');
    brain.embeddings!.delete(e.id);

    expect(brain.embeddings!.getMeta(e.id)).toBeNull();
    expect(brain.embeddings!.knnSearch(vec([1, 0, 0, 0]), 5).length).toBe(0);
  });

  it('cascades on entity delete', () => {
    const e = brain.entities.create({ type: 'concept', name: 'E', source: { type: 'manual' } });
    brain.embeddings!.upsert(e.id, vec([1, 0, 0, 0]), 'm', 'h');
    brain.entities.delete(e.id);
    // Embeddings table FK cascades. vec_embeddings is a virtual table — we
    // don't currently mirror cascades there, but knnSearch ignores stale rows
    // because the namespace filter join would drop them.
    expect(brain.embeddings!.getMeta(e.id)).toBeNull();
  });

  it('does not init EmbeddingStore when vectorDimensions omitted', () => {
    const plain = new Brain({ path: ':memory:', wal: false });
    expect(plain.embeddings).toBeNull();
    expect(plain.storage.vectorDimensions).toBeNull();
    plain.close();
  });

  it('enableVectorSearch lazily initializes the store', () => {
    const lazy = new Brain({ path: ':memory:', wal: false });
    expect(lazy.embeddings).toBeNull();
    const store = lazy.enableVectorSearch(DIM);
    expect(store).toBe(lazy.embeddings);
    expect(lazy.embeddings).not.toBeNull();
    lazy.close();
  });
});
