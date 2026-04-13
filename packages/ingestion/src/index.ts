// Pipeline
export { PipelineRunner } from './pipeline/index.js';
export { resolveRelations } from './pipeline/index.js';
export type {
  Collector,
  ExtractionResult,
  PendingRelation,
  PipelineConfig,
  PipelineProgress,
  PipelineRunSummary,
  ProgressCallback,
} from './pipeline/index.js';

// Collectors
export { GitCollector } from './git/index.js';
export type { GitCollectorOptions } from './git/index.js';
export { ASTCollector } from './ast/index.js';
export { GitHubCollector } from './github/index.js';
export type { GitHubCollectorOptions } from './github/index.js';
export { GitHubPRSchema, GitHubIssueSchema, GitHubReviewSchema } from './github/index.js';
export type { GitHubPR, GitHubIssue, GitHubReview } from './github/index.js';
export * from './conversation/index.js';
export * from './docs/index.js';

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
} from './extraction/index.js';
