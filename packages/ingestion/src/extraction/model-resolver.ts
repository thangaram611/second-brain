import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ai-sdk-ollama';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { LLMConfig, LLMProvider, EmbeddingProvider } from './llm-config.js';

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

function chatModelFor(provider: LLMProvider, model: string, opts: ProviderOpts): LanguageModel {
  switch (provider) {
    case 'openai': {
      const oa = createOpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
      return oa(model);
    }
    case 'anthropic': {
      const an = createAnthropic({ baseURL: opts.baseURL, apiKey: opts.apiKey });
      return an(model);
    }
    case 'ollama': {
      const ol = createOllama({ baseURL: opts.baseURL });
      return ol(model);
    }
    case 'groq': {
      // Groq exposes an OpenAI-compatible REST surface.
      const groq = createOpenAI({
        baseURL: opts.baseURL ?? 'https://api.groq.com/openai/v1',
        apiKey: opts.apiKey,
      });
      return groq(model);
    }
  }
}

function embeddingModelFor(
  provider: EmbeddingProvider,
  model: string,
  opts: ProviderOpts,
): EmbeddingModel {
  switch (provider) {
    case 'openai': {
      const oa = createOpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
      return oa.embedding(model);
    }
    case 'ollama': {
      const ol = createOllama({ baseURL: opts.baseURL });
      return ol.textEmbedding(model);
    }
    case 'groq': {
      const groq = createOpenAI({
        baseURL: opts.baseURL ?? 'https://api.groq.com/openai/v1',
        apiKey: opts.apiKey,
      });
      return groq.embedding(model);
    }
  }
}
