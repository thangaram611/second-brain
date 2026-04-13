import { describe, it, expect, vi } from 'vitest';
import {
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
  chatProviderRequiresKey,
  embeddingProviderRequiresKey,
} from '../extraction/factory.js';
import type { LLMConfig } from '../extraction/llm-config.js';

const ollamaConfig: LLMConfig = {
  provider: 'ollama',
  model: 'llama3.2',
  embeddingModel: 'nomic-embed-text',
};

const anthropicWithoutKey: LLMConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  embeddingModel: 'text-embedding-3-small',
  embeddingProvider: 'ollama',
};

const anthropicWithKey: LLMConfig = {
  ...anthropicWithoutKey,
  apiKey: 'sk-test',
};

describe('provider-key requirement helpers', () => {
  it('marks paid chat providers as requiring keys; ollama does not', () => {
    expect(chatProviderRequiresKey('anthropic')).toBe(true);
    expect(chatProviderRequiresKey('openai')).toBe(true);
    expect(chatProviderRequiresKey('groq')).toBe(true);
    expect(chatProviderRequiresKey('ollama')).toBe(false);
  });

  it('marks paid embedding providers as requiring keys; ollama does not', () => {
    expect(embeddingProviderRequiresKey('openai')).toBe(true);
    expect(embeddingProviderRequiresKey('groq')).toBe(true);
    expect(embeddingProviderRequiresKey('ollama')).toBe(false);
  });
});

describe('tryCreateLLMExtractor', () => {
  it('returns an extractor for ollama without a key', () => {
    const extractor = tryCreateLLMExtractor(ollamaConfig);
    expect(extractor).not.toBeNull();
  });

  it('returns null and warns when Anthropic lacks an API key', () => {
    const logger = { warn: vi.fn() };
    const extractor = tryCreateLLMExtractor(anthropicWithoutKey, { logger });
    expect(extractor).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/anthropic/);
  });

  it('returns an extractor when the key is provided', () => {
    const logger = { warn: vi.fn() };
    const extractor = tryCreateLLMExtractor(anthropicWithKey, { logger });
    expect(extractor).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('tryCreateEmbeddingGenerator', () => {
  it('returns a generator for ollama without a key', () => {
    const gen = tryCreateEmbeddingGenerator(ollamaConfig);
    expect(gen).not.toBeNull();
  });

  it('returns null and warns when OpenAI embeddings lack a key', () => {
    const cfg: LLMConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      embeddingModel: 'text-embedding-3-small',
      embeddingProvider: 'openai',
    };
    const logger = { warn: vi.fn() };
    const gen = tryCreateEmbeddingGenerator(cfg, { logger });
    expect(gen).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/openai/);
  });

  it('uses embeddingApiKey when provided separately from chat apiKey', () => {
    const cfg: LLMConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      embeddingModel: 'text-embedding-3-small',
      embeddingProvider: 'openai',
      embeddingApiKey: 'sk-emb',
    };
    const gen = tryCreateEmbeddingGenerator(cfg);
    expect(gen).not.toBeNull();
  });
});
