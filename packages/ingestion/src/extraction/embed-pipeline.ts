import type { Brain } from '@second-brain/core';
import type { Entity } from '@second-brain/types';
import { computeContentHash } from '../ast/content-hash.js';
import { EmbeddingGenerator } from './embedding-generator.js';

export interface EmbedPipelineOptions {
  /** Limit work to a single namespace. */
  namespace?: string;
  /** Max entities embedded per provider call. Default 64. */
  batchSize?: number;
  /** How many entities to scan per page when listing the brain. Default 500. */
  pageSize?: number;
  /** Optional callback invoked after each batch completes. */
  onProgress?: (progress: EmbedProgress) => void;
}

export interface EmbedProgress {
  scanned: number;
  embedded: number;
  skipped: number;
  errors: number;
}

export interface EmbedSummary extends EmbedProgress {
  durationMs: number;
}

/**
 * Build the text input that gets embedded. Uses entity name + observations
 * (which are the user-visible facts about the entity).
 */
function entityToText(entity: Entity): string {
  if (!entity.observations || entity.observations.length === 0) return entity.name;
  return `${entity.name}\n${entity.observations.join('\n')}`;
}

/**
 * Iterates through entities in the brain, computes content hashes, and
 * (re-)generates embeddings for any whose hash differs from what's stored.
 * Re-embedding is the only way to migrate to a new model — pass a freshly
 * constructed EmbeddingGenerator to switch providers/models.
 */
export class EmbedPipeline {
  constructor(
    private brain: Brain,
    private generator: EmbeddingGenerator,
    private options: EmbedPipelineOptions = {},
  ) {
    if (this.brain.embeddings === null) {
      throw new Error(
        'EmbedPipeline: brain.embeddings is null. Call brain.enableVectorSearch(dims) first.',
      );
    }
  }

  async run(): Promise<EmbedSummary> {
    const start = Date.now();
    const progress: EmbedProgress = { scanned: 0, embedded: 0, skipped: 0, errors: 0 };

    const pageSize = this.options.pageSize ?? 500;
    const batchSize = this.options.batchSize ?? 64;
    const namespace = this.options.namespace;

    let offset = 0;
    while (true) {
      const page = this.brain.entities.list({ namespace, limit: pageSize, offset });
      if (page.length === 0) break;
      progress.scanned += page.length;

      // Compute hashes for the page, then ask the store which need embedding.
      const items = page.map((e) => ({
        id: e.id,
        contentHash: computeContentHash(entityToText(e)),
      }));
      const staleIds = new Set(this.brain.embeddings!.findStale(items));
      progress.skipped += page.length - staleIds.size;

      const stale = page.filter((e) => staleIds.has(e.id));
      // Embed in batches.
      for (let i = 0; i < stale.length; i += batchSize) {
        const slice = stale.slice(i, i + batchSize);
        const inputs = slice.map((e) => ({
          id: e.id,
          text: entityToText(e),
          contentHash: computeContentHash(entityToText(e)),
        }));
        try {
          const embedded = await this.generator.generateBatch(inputs, batchSize);
          for (const r of embedded) {
            this.brain.embeddings!.upsert(r.entityId, r.vector, this.generator.modelName, r.contentHash);
            progress.embedded += 1;
          }
        } catch (err) {
          progress.errors += slice.length;
          // Continue with next batch — surface partial errors via progress.
          if (this.options.onProgress) this.options.onProgress({ ...progress });
          // Re-throw if every batch is failing for the same reason.
          throw err instanceof Error ? err : new Error(String(err));
        }
        if (this.options.onProgress) this.options.onProgress({ ...progress });
      }

      if (page.length < pageSize) break;
      offset += pageSize;
    }

    return { ...progress, durationMs: Date.now() - start };
  }
}
