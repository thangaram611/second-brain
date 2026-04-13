import { embedMany, embed } from 'ai';
import type { EmbeddingModel } from 'ai';
import type { LLMConfig } from './llm-config.js';
import { resolveEmbeddingModel } from './model-resolver.js';

export interface EmbedItem {
  id: string;
  text: string;
  contentHash: string;
}

export interface EmbedResult {
  entityId: string;
  vector: Float32Array;
  contentHash: string;
}

/**
 * Wraps the AI SDK `embedMany`/`embed` calls with batching and provider-agnostic
 * model resolution. Returns Float32Array vectors ready for sqlite-vec storage.
 */
export class EmbeddingGenerator {
  readonly modelName: string;
  private readonly model: EmbeddingModel;

  constructor(config: LLMConfig) {
    this.modelName = config.embeddingModel;
    this.model = resolveEmbeddingModel(config);
  }

  /** Generate a single embedding (used for query-time vector lookup). */
  async generateOne(text: string): Promise<Float32Array> {
    const { embedding } = await embed({ model: this.model, value: text });
    return Float32Array.from(embedding);
  }

  /**
   * Generate embeddings for a batch. Splits into chunks of `batchSize`
   * to keep request payloads manageable for cloud providers.
   */
  async generateBatch(items: ReadonlyArray<EmbedItem>, batchSize = 64): Promise<EmbedResult[]> {
    if (items.length === 0) return [];

    const out: EmbedResult[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const slice = items.slice(i, i + batchSize);
      const { embeddings } = await embedMany({
        model: this.model,
        values: slice.map((it) => it.text),
      });
      if (embeddings.length !== slice.length) {
        throw new Error(
          `EmbeddingGenerator: provider returned ${embeddings.length} vectors for ${slice.length} inputs`,
        );
      }
      for (let j = 0; j < slice.length; j++) {
        out.push({
          entityId: slice[j].id,
          vector: Float32Array.from(embeddings[j]),
          contentHash: slice[j].contentHash,
        });
      }
    }
    return out;
  }
}
