import type { Entity, SearchOptions } from '@second-brain/types';
import type { EmbeddingStore } from '../embeddings/index.js';
import type { EntityManager } from '../graph/entity-manager.js';
import type { RankedResult } from './fusion.js';

/**
 * Async function that turns a query string into a vector embedding.
 * Injected so `core` doesn't depend on the AI SDK / `ingestion` package.
 */
export type QueryEmbedder = (query: string) => Promise<Float32Array>;

/**
 * Vector search channel — wraps an EmbeddingStore + a query embedder and
 * exposes a channel-shaped result list for RRF fusion.
 */
export class VectorSearchChannel {
  constructor(
    private store: EmbeddingStore,
    private entities: EntityManager,
    private embedQuery: QueryEmbedder,
  ) {}

  async search(options: SearchOptions): Promise<RankedResult[]> {
    const { query, namespace, types, limit = 20, minConfidence } = options;
    if (!query.trim()) return [];

    const queryVec = await this.embedQuery(query);
    const hits = this.store.knnSearch(queryVec, limit, { namespace, types, minConfidence });

    const results: RankedResult[] = [];
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const entity = this.entities.get(hit.entityId);
      if (!entity) continue; // Tolerate stale vec rows (e.g. entity deleted).
      results.push({
        entityId: entity.id,
        entity,
        rank: i + 1,
        channel: 'vector',
        // Cosine distance ∈ [0, 2]; convert to similarity ∈ [-1, 1].
        channelScore: 1 - hit.distance,
      });
    }
    return results;
  }
}

/** Helper: turn fulltext SearchResult[] into RankedResult[] for fusion. */
export function fulltextToRanked(
  results: ReadonlyArray<{ entity: Entity; score: number }>,
): RankedResult[] {
  return results.map((r, i) => ({
    entityId: r.entity.id,
    entity: r.entity,
    rank: i + 1,
    channel: 'fulltext' as const,
    channelScore: r.score,
  }));
}
