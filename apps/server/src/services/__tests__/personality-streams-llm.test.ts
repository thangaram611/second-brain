import { describe, it, expect, afterEach, vi } from 'vitest';
import { Brain } from '@second-brain/core';
import type { LLMHandle, PersonalityContext } from '../personality-extractor.js';
import { decisionPatternsStream } from '../personality/decision-patterns.js';
import { communicationStyleStream } from '../personality/communication-style.js';

describe('Personality LLM streams', () => {
  let brain: Brain;

  afterEach(async () => {
    await brain?.close();
  });

  function makeBrain(): Brain {
    brain = new Brain({ path: ':memory:', wal: false });
    return brain;
  }

  const silentLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  function makeCtx(
    overrides: Partial<PersonalityContext> = {},
  ): PersonalityContext {
    return {
      brain: overrides.brain ?? makeBrain(),
      actor: 'test-user',
      llm: overrides.llm ?? null,
      logger: silentLogger,
      now: new Date(),
      ...overrides,
    };
  }

  const mockLLM: LLMHandle = {
    generate: async (prompt: string) => {
      if (prompt.includes('decision')) {
        return 'Developers tend to prefer pragmatic solutions over theoretical perfection, choosing working implementations first.';
      }
      return JSON.stringify({
        verbosity: 'moderate',
        formality: 'neutral',
        humorMarkers: 3,
      });
    },
  };

  function seedDecisions(b: Brain, count: number, actor = 'test-user'): void {
    for (let i = 0; i < count; i++) {
      b.entities.create({
        type: 'decision',
        name: `decision-${i}`,
        namespace: 'project-abc',
        source: { type: 'github', ref: `pr-${i}`, actor },
        observations: [`Chose approach ${i} because it was simpler and more maintainable`],
        tags: [],
      });
    }
  }

  function seedMREntities(b: Brain, count: number, actor = 'test-user'): void {
    const types = ['merge_request', 'pull_request', 'review'] as const;
    for (let i = 0; i < count; i++) {
      b.entities.create({
        type: types[i % types.length],
        name: `mr-${i}`,
        namespace: 'project-abc',
        source: { type: 'github', ref: `ref-${i}`, actor },
        observations: [`This MR adds feature ${i} with clear documentation and tests`],
        tags: [],
      });
    }
  }

  // --- decision-patterns ---

  describe('decision-patterns', () => {
    it('creates pattern entity with enough decisions and LLM', async () => {
      const b = makeBrain();
      seedDecisions(b, 8);

      const result = await decisionPatternsStream.run(
        makeCtx({ brain: b, llm: mockLLM }),
      );

      expect(result.created).toBeGreaterThanOrEqual(1);
      expect(result.updated).toBe(0);

      // Verify the pattern entity was created
      const patterns = b.storage.sqlite
        .prepare(`SELECT * FROM entities WHERE type = 'pattern'`)
        .all() as Record<string, unknown>[];
      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const props = JSON.parse(patterns[0].properties as string);
      expect(props.summary).toBeTruthy();
      expect(props.decisionCount).toBeGreaterThanOrEqual(5);
    });

    it('skips with fewer than 5 decisions', async () => {
      const b = makeBrain();
      seedDecisions(b, 3);

      const result = await decisionPatternsStream.run(
        makeCtx({ brain: b, llm: mockLLM }),
      );

      expect(result).toEqual({ created: 0, updated: 0 });
    });

    it('skips without LLM', async () => {
      const b = makeBrain();
      seedDecisions(b, 10);

      const result = await decisionPatternsStream.run(
        makeCtx({ brain: b, llm: null }),
      );

      expect(result).toEqual({ created: 0, updated: 0 });
    });

    it('creates derived_from relations to source decisions', async () => {
      const b = makeBrain();
      seedDecisions(b, 8);

      await decisionPatternsStream.run(
        makeCtx({ brain: b, llm: mockLLM }),
      );

      const relations = b.storage.sqlite
        .prepare(
          `SELECT * FROM relations WHERE type = 'derived_from' AND source_ref = 'decision-patterns'`,
        )
        .all() as Record<string, unknown>[];

      expect(relations.length).toBeGreaterThanOrEqual(1);
      // Each relation points from pattern to a decision
      for (const rel of relations) {
        expect(rel.type).toBe('derived_from');
      }
    });

    it('verbatim output triggers regeneration', async () => {
      const b = makeBrain();
      // Seed decisions with distinctive text so we can make verbatim match
      for (let i = 0; i < 8; i++) {
        b.entities.create({
          type: 'decision',
          name: `decision-${i}`,
          namespace: 'project-abc',
          source: { type: 'github', ref: `pr-${i}`, actor: 'test-user' },
          observations: [
            'The team decided to use pragmatic solutions over theoretical perfection for working implementations first',
          ],
          tags: [],
        });
      }

      let callCount = 0;
      const verbatimThenClean: LLMHandle = {
        generate: async () => {
          callCount++;
          if (callCount === 1) {
            // First call returns verbatim-ish text matching source ngrams
            return 'The team decided to use pragmatic solutions over theoretical perfection for working implementations first';
          }
          // Second call returns clean abstract
          return 'A consistent preference for practical shipping over idealized architecture.';
        },
      };

      const result = await decisionPatternsStream.run(
        makeCtx({ brain: b, llm: verbatimThenClean }),
      );

      expect(callCount).toBe(2); // regenerated once
      expect(result.created).toBe(1);
    });
  });

  // --- communication-style ---

  describe('communication-style', () => {
    it('creates fact entity with MR entities and LLM', async () => {
      const b = makeBrain();
      seedMREntities(b, 5);

      const result = await communicationStyleStream.run(
        makeCtx({ brain: b, llm: mockLLM }),
      );

      expect(result.created).toBeGreaterThanOrEqual(1);
      expect(result.updated).toBe(0);

      const facts = b.storage.sqlite
        .prepare(
          `SELECT * FROM entities WHERE type = 'fact' AND name LIKE 'communication-style:%'`,
        )
        .all() as Record<string, unknown>[];
      expect(facts.length).toBeGreaterThanOrEqual(1);

      const props = JSON.parse(facts[0].properties as string);
      expect(props.verbosity).toBe('moderate');
      expect(props.formality).toBe('neutral');
      expect(props.humorMarkers).toBe(3);
      expect(props.sampleSize).toBeGreaterThanOrEqual(1);
    });

    it('skips with fewer than 3 entities', async () => {
      const b = makeBrain();
      seedMREntities(b, 2);

      const result = await communicationStyleStream.run(
        makeCtx({ brain: b, llm: mockLLM }),
      );

      expect(result).toEqual({ created: 0, updated: 0 });
    });

    it('skips without LLM', async () => {
      const b = makeBrain();
      seedMREntities(b, 5);

      const result = await communicationStyleStream.run(
        makeCtx({ brain: b, llm: null }),
      );

      expect(result).toEqual({ created: 0, updated: 0 });
    });

    it('parses LLM JSON output correctly', async () => {
      const b = makeBrain();
      seedMREntities(b, 5);

      const jsonLLM: LLMHandle = {
        generate: async () =>
          '```json\n{"verbosity":"verbose","formality":"formal","humorMarkers":7}\n```',
      };

      const result = await communicationStyleStream.run(
        makeCtx({ brain: b, llm: jsonLLM }),
      );

      expect(result.created).toBeGreaterThanOrEqual(1);

      const facts = b.storage.sqlite
        .prepare(
          `SELECT * FROM entities WHERE type = 'fact' AND name LIKE 'communication-style:%'`,
        )
        .all() as Record<string, unknown>[];

      const props = JSON.parse(facts[0].properties as string);
      expect(props.verbosity).toBe('verbose');
      expect(props.formality).toBe('formal');
      expect(props.humorMarkers).toBe(7);
    });
  });
});
