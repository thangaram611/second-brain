import { z } from 'zod';

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai', 'groq'] as const;

/**
 * Providers that expose an embedding endpoint. `anthropic` is intentionally
 * excluded — Anthropic does not provide first-party embeddings.
 */
export const EMBEDDING_PROVIDERS = ['ollama', 'openai', 'groq'] as const;

export const LLMConfigSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    model: z.string(),
    embeddingModel: z.string(),
    /**
     * Vendor that serves embeddings. Defaults to `provider` when unset.
     * Anthropic users MUST set this to a non-anthropic value.
     */
    embeddingProvider: z.enum(EMBEDDING_PROVIDERS).optional(),
    baseUrl: z.string().url().optional(),
    /** Separate base URL for the embedding provider (when it differs from chat). */
    embeddingBaseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    /** Separate API key for the embedding provider (when it differs from chat). */
    embeddingApiKey: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    const embProvider = cfg.embeddingProvider ?? cfg.provider;
    // Runtime guard — the goal is to reject 'anthropic' as an embedding provider with a clear error.
    if ((EMBEDDING_PROVIDERS as readonly string[]).indexOf(embProvider) === -1) {
      ctx.addIssue({
        code: 'custom',
        path: ['embeddingProvider'],
        message: `Provider "${embProvider}" does not support embeddings. Set embeddingProvider explicitly (one of: ${EMBEDDING_PROVIDERS.join(', ')}).`,
      });
    }
  });

export type LLMProvider = (typeof LLM_PROVIDERS)[number];
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];
export type LLMConfig = z.infer<typeof LLMConfigSchema>;

/**
 * Resolve LLM config from explicit options, falling back to environment variables,
 * then to defaults. Validates the result with Zod.
 */
export function resolveLLMConfig(override?: Partial<LLMConfig>): LLMConfig {
  const raw = {
    provider: override?.provider ?? process.env.BRAIN_LLM_PROVIDER ?? 'ollama',
    model: override?.model ?? process.env.BRAIN_LLM_MODEL ?? 'llama3.2',
    embeddingModel: override?.embeddingModel ?? process.env.BRAIN_EMBEDDING_MODEL ?? 'nomic-embed-text',
    embeddingProvider:
      override?.embeddingProvider ?? process.env.BRAIN_EMBEDDING_PROVIDER ?? undefined,
    baseUrl: override?.baseUrl ?? process.env.BRAIN_LLM_BASE_URL ?? undefined,
    embeddingBaseUrl:
      override?.embeddingBaseUrl ?? process.env.BRAIN_EMBEDDING_BASE_URL ?? undefined,
    apiKey: override?.apiKey ?? process.env.BRAIN_LLM_API_KEY ?? undefined,
    embeddingApiKey: override?.embeddingApiKey ?? process.env.BRAIN_EMBEDDING_API_KEY ?? undefined,
  };
  return LLMConfigSchema.parse(raw);
}
