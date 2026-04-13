import type { EntitySource } from '@second-brain/types';
import type { Collector, ExtractionResult, PipelineConfig } from '../pipeline/types.js';
import type { LLMExtractor } from './llm-extractor.js';

export interface LLMCollectorInput {
  /** Raw text to extract entities and relations from. */
  content: string;
  /** Source attribution override for this specific input. */
  source?: EntitySource;
}

export interface LLMCollectorOptions {
  /** Default source attribution for inputs that don't specify their own. */
  defaultSource: EntitySource;
  /** Optional collector name override (defaults to 'llm'). */
  name?: string;
}

/**
 * Generic Collector that runs LLMExtractor over a list of text inputs.
 * Used by docs/conversation collectors that want to delegate the actual
 * extraction to the LLM rather than doing deterministic parsing only.
 */
export class LLMCollector implements Collector {
  readonly name: string;

  constructor(
    private extractor: LLMExtractor,
    private inputs: ReadonlyArray<LLMCollectorInput>,
    private options: LLMCollectorOptions,
  ) {
    this.name = options.name ?? 'llm';
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const merged: ExtractionResult = { entities: [], relations: [] };

    for (let i = 0; i < this.inputs.length; i++) {
      const input = this.inputs[i];
      const result = await this.extractor.extract(input.content, {
        namespace: config.namespace,
        source: input.source ?? this.options.defaultSource,
      });
      merged.entities.push(...result.entities);
      merged.relations.push(...result.relations);

      if (config.onProgress) {
        config.onProgress({
          stage: 'collecting',
          collector: this.name,
          current: i + 1,
          total: this.inputs.length,
          message: `extracted ${result.entities.length} entities`,
        });
      }
    }

    return merged;
  }
}
