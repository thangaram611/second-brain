// Content hash utility (shared across ingestion packages)
export { computeContentHash } from './content-hash.js';

// Network helpers (retry with exponential backoff + jitter)
export { withRetry, defaultShouldRetry, computeBackoff } from './net/retry.js';
export type { RetryOptions } from './net/retry.js';

// Pipeline types (Collector interface + pipeline data shapes)
export type {
  Collector,
  ExtractionResult,
  PendingRelation,
  PipelineConfig,
  PipelineProgress,
  PipelineRunSummary,
  ProgressCallback,
} from './pipeline/types.js';

// LLM extraction + embeddings
export {
  resolveLLMConfig,
  LLMConfigSchema,
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  resolveChatModel,
  resolveEmbeddingModel,
  EmbeddingGenerator,
  EmbedPipeline,
  LLMExtractor,
  LLMCollector,
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
  chatProviderRequiresKey,
  embeddingProviderRequiresKey,
} from './extraction/index.js';
export type {
  LLMConfig,
  LLMProvider,
  EmbeddingProvider,
  EmbedItem,
  EmbedResult,
  EmbedPipelineOptions,
  EmbedProgress,
  EmbedSummary,
  LLMExtractorOptions,
  ExtractContext,
  ExtractedShape,
  LLMCollectorInput,
  LLMCollectorOptions,
  DegradationLogger,
} from './extraction/index.js';
