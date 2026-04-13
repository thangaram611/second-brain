import type { LLMConfig, LLMProvider, EmbeddingProvider } from './llm-config.js';
import { LLMExtractor, type LLMExtractorOptions } from './llm-extractor.js';
import { EmbeddingGenerator } from './embedding-generator.js';

const PROVIDERS_REQUIRING_KEY: readonly LLMProvider[] = ['anthropic', 'openai', 'groq'];
const EMBEDDING_PROVIDERS_REQUIRING_KEY: readonly EmbeddingProvider[] = ['openai', 'groq'];

export function chatProviderRequiresKey(provider: LLMProvider): boolean {
  return PROVIDERS_REQUIRING_KEY.includes(provider);
}

export function embeddingProviderRequiresKey(provider: EmbeddingProvider): boolean {
  return EMBEDDING_PROVIDERS_REQUIRING_KEY.includes(provider);
}

export interface DegradationLogger {
  warn: (message: string) => void;
}

/**
 * Build an LLMExtractor if the config is complete enough; otherwise return null
 * and emit a warning. Pipelines can then skip LLM enrichment without crashing.
 */
export function tryCreateLLMExtractor(
  config: LLMConfig,
  options: { logger?: DegradationLogger } & LLMExtractorOptions = {},
): LLMExtractor | null {
  const { logger, ...extractorOptions } = options;
  if (chatProviderRequiresKey(config.provider) && !config.apiKey) {
    logger?.warn(
      `LLM extraction disabled: provider "${config.provider}" requires an API key. ` +
        `Set BRAIN_LLM_API_KEY or pass --token to enable decision/fact/pattern enrichment.`,
    );
    return null;
  }
  return new LLMExtractor(config, extractorOptions);
}

/**
 * Build an EmbeddingGenerator if the config is complete enough; otherwise return
 * null. Callers (embed pipeline, vector search) should skip embeddings when null.
 */
export function tryCreateEmbeddingGenerator(
  config: LLMConfig,
  options: { logger?: DegradationLogger } = {},
): EmbeddingGenerator | null {
  const effective: EmbeddingProvider =
    config.embeddingProvider ?? (config.provider === 'anthropic' ? 'ollama' : (config.provider as EmbeddingProvider));
  const keyInUse = config.embeddingApiKey ?? config.apiKey;
  if (embeddingProviderRequiresKey(effective) && !keyInUse) {
    options.logger?.warn(
      `Embedding generation disabled: provider "${effective}" requires an API key. ` +
        `Set BRAIN_EMBEDDING_API_KEY or BRAIN_LLM_API_KEY to enable vector search.`,
    );
    return null;
  }
  return new EmbeddingGenerator(config);
}
