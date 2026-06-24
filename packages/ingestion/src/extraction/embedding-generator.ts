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

  /**
   * qwen3-embedding is trained asymmetrically: search QUERIES get an instruction
   * prefix, indexed DOCUMENTS do not. Without it, qwen3 query/document cosine
   * sims cluster tightly (~0.016 here) — ranking is right but separation is poor.
   * Other models embed the query verbatim.
   */
  private static readonly QWEN3_QUERY_INSTRUCTION =
    'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ';

  /** Generate a single embedding for indexed content (no query instruction). */
  async generateOne(text: string): Promise<Float32Array> {
    const { embedding } = await embed({ model: this.model, value: text });
    return Float32Array.from(embedding);
  }

  /**
   * Generate a single QUERY embedding for vector-search lookup, applying any
   * model-specific query instruction prefix. Documents must continue to use
   * {@link generateOne}/{@link generateBatch} so the query/document asymmetry
   * the model was trained on is preserved.
   */
  async generateQuery(text: string): Promise<Float32Array> {
    return this.generateOne(this.applyQueryInstruction(text));
  }

  private applyQueryInstruction(text: string): string {
    if (this.modelName.toLowerCase().includes('qwen3')) {
      return `${EmbeddingGenerator.QWEN3_QUERY_INSTRUCTION}${text}`;
    }
    return text;
  }

  /**
   * Probe the model's native embedding dimension by embedding a tiny sentinel
   * string and measuring the result. Lets callers size the vec table to the
   * model instead of hardcoding a default that only fits one model family.
   */
  async probeDimensions(): Promise<number> {
    const v = await this.generateOne('dimension probe');
    return v.length;
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
