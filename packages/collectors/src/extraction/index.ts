// LLM/embedding symbols live in @second-brain/ingestion (the slim package).
// Re-exported from @second-brain/collectors for convenience so a single
// import covers both collectors and the LLM/embedding pieces they compose with.
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
} from '@second-brain/ingestion';
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
} from '@second-brain/ingestion';
