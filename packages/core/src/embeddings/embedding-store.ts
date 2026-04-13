import type { EntityType } from '@second-brain/types';
import type { StorageDatabase } from '../storage/index.js';

export interface EmbeddingMeta {
  model: string;
  contentHash: string;
  createdAt: string;
}

export interface KnnHit {
  entityId: string;
  /** Cosine distance from query vector (lower = more similar). */
  distance: number;
}

export interface KnnSearchOptions {
  namespace?: string;
  types?: EntityType[];
  /** Optional minimum entity confidence (after no-decay filter). */
  minConfidence?: number;
}

/**
 * Convert a Float32Array into a Buffer for sqlite-vec / SQLite BLOB storage.
 * sqlite-vec expects raw little-endian f32 bytes.
 */
function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Manages embedding vectors for entities.
 *
 * Storage strategy:
 * - `embeddings` table is the source of truth (vector blob, model, content hash).
 * - `vec_embeddings` virtual table is the KNN index (sqlite-vec vec0).
 * Both are updated together in `upsert()`.
 */
export class EmbeddingStore {
  constructor(private storage: StorageDatabase) {
    if (storage.vectorDimensions === null) {
      throw new Error(
        'EmbeddingStore requires storage.enableVectorSearch(dimensions) to be called first.',
      );
    }
  }

  /** Upsert an embedding for an entity. Updates both embeddings and vec_embeddings. */
  upsert(entityId: string, vector: Float32Array, model: string, contentHash: string): void {
    const dims = this.storage.vectorDimensions;
    if (dims === null) {
      throw new Error('EmbeddingStore.upsert: vector search is not enabled');
    }
    if (vector.length !== dims) {
      throw new Error(
        `EmbeddingStore.upsert: vector length ${vector.length} does not match table dimension ${dims}`,
      );
    }

    const buf = vectorToBuffer(vector);
    const now = new Date().toISOString();

    // Use a transaction so the two tables stay consistent.
    const txn = this.storage.sqlite.transaction(() => {
      this.storage.sqlite
        .prepare(
          `INSERT INTO embeddings (entity_id, vector, model, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entity_id) DO UPDATE SET
             vector = excluded.vector,
             model = excluded.model,
             content_hash = excluded.content_hash,
             created_at = excluded.created_at`,
        )
        .run(entityId, buf, model, contentHash, now);

      // vec0 virtual tables don't support ON CONFLICT; delete-then-insert.
      this.storage.sqlite
        .prepare(`DELETE FROM vec_embeddings WHERE entity_id = ?`)
        .run(entityId);
      this.storage.sqlite
        .prepare(`INSERT INTO vec_embeddings (entity_id, embedding) VALUES (?, ?)`)
        .run(entityId, buf);
    });
    txn();
  }

  /** Get embedding metadata (without the full vector) for an entity. */
  getMeta(entityId: string): EmbeddingMeta | null {
    const row = this.storage.sqlite
      .prepare(
        `SELECT model, content_hash AS contentHash, created_at AS createdAt
         FROM embeddings WHERE entity_id = ?`,
      )
      .get(entityId);
    if (!row) return null;
    const r = row as { model: string; contentHash: string | null; createdAt: string };
    if (r.contentHash === null) return null;
    return { model: r.model, contentHash: r.contentHash, createdAt: r.createdAt };
  }

  /**
   * Given a batch of {id, contentHash} pairs, return ids that need (re-)embedding:
   * either no row exists, or the stored content_hash differs.
   */
  findStale(items: ReadonlyArray<{ id: string; contentHash: string }>): string[] {
    if (items.length === 0) return [];

    // Map ids to expected hashes. Then query in chunks (SQLite parameter limit).
    const expected = new Map<string, string>();
    for (const it of items) expected.set(it.id, it.contentHash);

    const ids = Array.from(expected.keys());
    const stale = new Set<string>(ids); // assume all stale; remove fresh ones below

    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.storage.sqlite
        .prepare(
          `SELECT entity_id AS entityId, content_hash AS contentHash
           FROM embeddings WHERE entity_id IN (${placeholders})`,
        )
        .all(...slice) as Array<{ entityId: string; contentHash: string | null }>;
      for (const row of rows) {
        if (row.contentHash !== null && expected.get(row.entityId) === row.contentHash) {
          stale.delete(row.entityId);
        }
      }
    }
    return Array.from(stale);
  }

  /** Delete embedding for an entity from both tables. */
  delete(entityId: string): void {
    const txn = this.storage.sqlite.transaction(() => {
      this.storage.sqlite.prepare(`DELETE FROM embeddings WHERE entity_id = ?`).run(entityId);
      this.storage.sqlite.prepare(`DELETE FROM vec_embeddings WHERE entity_id = ?`).run(entityId);
    });
    txn();
  }

  /**
   * KNN search: returns the `k` entity ids closest to `queryVector`,
   * optionally filtered by namespace/types/minConfidence.
   *
   * Strategy: query vec_embeddings for k*overScan candidates, then JOIN
   * with entities to apply filters in JS.
   */
  knnSearch(queryVector: Float32Array, k: number, options: KnnSearchOptions = {}): KnnHit[] {
    const dims = this.storage.vectorDimensions;
    if (dims === null) {
      throw new Error('EmbeddingStore.knnSearch: vector search is not enabled');
    }
    if (queryVector.length !== dims) {
      throw new Error(
        `EmbeddingStore.knnSearch: query length ${queryVector.length} does not match table dimension ${dims}`,
      );
    }
    if (k <= 0) return [];

    const overScan = options.namespace || options.types || options.minConfidence ? 5 : 1;
    const fetchK = Math.max(k * overScan, k);

    const buf = vectorToBuffer(queryVector);
    const candidates = this.storage.sqlite
      .prepare(
        `SELECT entity_id AS entityId, distance
         FROM vec_embeddings
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(buf, fetchK) as Array<{ entityId: string; distance: number }>;

    if (candidates.length === 0) return [];
    if (!options.namespace && !options.types && !options.minConfidence) {
      return candidates.slice(0, k);
    }

    // Filter by entity attributes.
    const ids = candidates.map((c) => c.entityId);
    const placeholders = ids.map(() => '?').join(',');
    const params: unknown[] = [...ids];

    let whereExtra = '';
    if (options.namespace) {
      whereExtra += ' AND namespace = ?';
      params.push(options.namespace);
    }
    if (options.types && options.types.length > 0) {
      whereExtra += ` AND type IN (${options.types.map(() => '?').join(',')})`;
      params.push(...options.types);
    }
    if (typeof options.minConfidence === 'number' && options.minConfidence > 0) {
      whereExtra += ' AND confidence >= ?';
      params.push(options.minConfidence);
    }

    const allowedRows = this.storage.sqlite
      .prepare(`SELECT id FROM entities WHERE id IN (${placeholders})${whereExtra}`)
      .all(...params) as Array<{ id: string }>;
    const allowed = new Set(allowedRows.map((r) => r.id));

    const filtered: KnnHit[] = [];
    for (const c of candidates) {
      if (allowed.has(c.entityId)) {
        filtered.push(c);
        if (filtered.length === k) break;
      }
    }
    return filtered;
  }
}
