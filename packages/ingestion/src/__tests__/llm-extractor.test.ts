import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateObjectMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateObject: generateObjectMock,
  };
});

// Import after the mock so the module sees the mocked binding.
const { LLMExtractor } = await import('../extraction/llm-extractor.js');
const { LLMCollector } = await import('../extraction/llm-collector.js');

const cfg = {
  provider: 'ollama' as const,
  model: 'llama3.2',
  embeddingModel: 'nomic-embed-text',
};

beforeEach(() => {
  generateObjectMock.mockReset();
});

describe('LLMExtractor', () => {
  it('shapes the LLM output into pipeline entities + relations', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        entities: [
          { type: 'decision', name: 'Use SQLite', observations: ['local-first'] },
          { type: 'tool', name: 'SQLite' },
        ],
        relations: [
          {
            type: 'uses',
            sourceName: 'Use SQLite',
            sourceType: 'decision',
            targetName: 'SQLite',
            targetType: 'tool',
          },
        ],
      },
    });

    const extractor = new LLMExtractor(cfg);
    const result = await extractor.extract('We chose SQLite because we want local-first.', {
      source: { type: 'manual' },
    });

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].type).toBe('decision');
    expect(result.entities[0].observations).toEqual(['local-first']);
    expect(result.entities[0].source.type).toBe('manual');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].sourceName).toBe('Use SQLite');
    expect(result.relations[0].targetType).toBe('tool');
  });

  it('drops relations whose endpoints were not extracted', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        entities: [{ type: 'concept', name: 'CRDT' }],
        relations: [
          {
            type: 'relates_to',
            sourceName: 'CRDT',
            sourceType: 'concept',
            targetName: 'Phantom',
            targetType: 'concept',
          },
        ],
      },
    });

    const extractor = new LLMExtractor(cfg);
    const result = await extractor.extract('CRDT is a thing.', { source: { type: 'manual' } });
    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(0);
  });

  it('returns empty result for blank input without calling the LLM', async () => {
    const extractor = new LLMExtractor(cfg);
    const result = await extractor.extract('   ', { source: { type: 'manual' } });
    expect(result.entities).toHaveLength(0);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('truncates oversized input to maxInputChars', async () => {
    generateObjectMock.mockResolvedValue({ object: { entities: [], relations: [] } });
    const extractor = new LLMExtractor(cfg, { maxInputChars: 10 });
    await extractor.extract('hello world this is much longer than ten chars', {
      source: { type: 'manual' },
    });
    const call = generateObjectMock.mock.calls[0][0];
    expect(call.prompt.length).toBeLessThanOrEqual(10);
  });

  it('uses the configured namespace on extracted entities', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        entities: [{ type: 'fact', name: 'Earth is round' }],
        relations: [],
      },
    });
    const extractor = new LLMExtractor(cfg);
    const result = await extractor.extract('Earth is round.', {
      namespace: 'project-alpha',
      source: { type: 'manual' },
    });
    expect(result.entities[0].namespace).toBe('project-alpha');
  });
});

describe('LLMCollector', () => {
  it('runs LLMExtractor over multiple inputs and merges results', async () => {
    generateObjectMock
      .mockResolvedValueOnce({
        object: {
          entities: [{ type: 'fact', name: 'Fact A' }],
          relations: [],
        },
      })
      .mockResolvedValueOnce({
        object: {
          entities: [{ type: 'fact', name: 'Fact B' }],
          relations: [],
        },
      });

    const extractor = new LLMExtractor(cfg);
    const collector = new LLMCollector(
      extractor,
      [{ content: 'first text' }, { content: 'second text' }],
      { defaultSource: { type: 'doc', ref: 'spec.md' } },
    );

    const result = await collector.collect({
      namespace: 'personal',
      ignorePatterns: [],
    });
    expect(result.entities.map((e) => e.name)).toEqual(['Fact A', 'Fact B']);
    expect(result.entities[0].source.ref).toBe('spec.md');
  });
});
