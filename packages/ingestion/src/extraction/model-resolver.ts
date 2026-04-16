import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ai-sdk-ollama';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { LLMConfig, LLMProvider, EmbeddingProvider } from './llm-config.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Resolve the AI SDK chat (language) model for the configured provider. */
export function resolveChatModel(config: LLMConfig): LanguageModel {
  return chatModelFor(config.provider, config.model, {
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
}

/** Resolve the AI SDK embedding model for the configured embedding provider. */
export function resolveEmbeddingModel(config: LLMConfig): EmbeddingModel {
  const provider: EmbeddingProvider = config.embeddingProvider ?? embeddingDefaultFor(config.provider);
  const baseURL = config.embeddingBaseUrl ?? (config.embeddingProvider ? undefined : config.baseUrl);
  const apiKey = config.embeddingApiKey ?? (config.embeddingProvider ? undefined : config.apiKey);
  return embeddingModelFor(provider, config.embeddingModel, { baseURL, apiKey });
}

/** Suggest a default embedding provider when chat provider can't embed. */
function embeddingDefaultFor(chat: LLMProvider): EmbeddingProvider {
  // anthropic has no embeddings; everything else can self-serve.
  if (chat === 'anthropic') return 'ollama';
  return chat;
}

interface ProviderOpts {
  baseURL?: string;
  apiKey?: string;
}

/** Create an OpenAI-compatible provider (covers both openai and groq). */
function openaiLike(opts: ProviderOpts, defaultBaseURL?: string) {
  return createOpenAI({
    baseURL: opts.baseURL ?? defaultBaseURL,
    apiKey: opts.apiKey,
  });
}

function chatModelFor(provider: LLMProvider, model: string, opts: ProviderOpts): LanguageModel {
  switch (provider) {
    case 'openai':    return openaiLike(opts)(model);
    case 'anthropic': return createAnthropic({ baseURL: opts.baseURL, apiKey: opts.apiKey })(model);
    case 'ollama':    return createOllama({ baseURL: opts.baseURL })(model);
    case 'groq':      return openaiLike(opts, GROQ_BASE_URL)(model);
  }
}

function embeddingModelFor(
  provider: EmbeddingProvider,
  model: string,
  opts: ProviderOpts,
): EmbeddingModel {
  switch (provider) {
    case 'openai': return openaiLike(opts).embedding(model);
    case 'ollama': return createOllama({ baseURL: opts.baseURL }).textEmbedding(model);
    case 'groq':   return openaiLike(opts, GROQ_BASE_URL).embedding(model);
  }
}
