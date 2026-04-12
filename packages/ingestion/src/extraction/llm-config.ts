import { z } from 'zod';

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai', 'groq'] as const;

export const LLMConfigSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string(),
  embeddingModel: z.string(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export type LLMProvider = (typeof LLM_PROVIDERS)[number];
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
    baseUrl: override?.baseUrl ?? process.env.BRAIN_LLM_BASE_URL ?? undefined,
    apiKey: override?.apiKey ?? process.env.BRAIN_LLM_API_KEY ?? undefined,
  };
  return LLMConfigSchema.parse(raw);
}
