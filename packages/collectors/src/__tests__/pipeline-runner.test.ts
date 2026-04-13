import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '@second-brain/core';
import { PipelineRunner } from '../pipeline/runner.js';
import type { Collector, ExtractionResult, PipelineConfig } from '@second-brain/ingestion';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function makeCollector(
  name: string,
  result: ExtractionResult,
): Collector {
  return {
    name,
    collect: async () => result,
  };
}

function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    namespace: 'personal',
    repoPath: '/tmp/test',
    ignorePatterns: ['node_modules', 'dist'],
    ...overrides,
  };
}

describe('PipelineRunner', () => {
  it('runs an empty pipeline', async () => {
    const runner = new PipelineRunner(brain);
    const summary = await runner.run(makeConfig());

    expect(summary.entitiesCreated).toBe(0);
    expect(summary.relationsCreated).toBe(0);
    expect(summary.errors).toHaveLength(0);
  });

  it('creates entities from a collector', async () => {
    const runner = new PipelineRunner(brain);
    runner.register(
      makeCollector('test', {
        entities: [
          { type: 'concept', name: 'CRDT', source: { type: 'manual' } },
          { type: 'concept', name: 'Yjs', source: { type: 'manual' } },
        ],
        relations: [],
      }),
    );

    const summary = await runner.run(makeConfig());
    expect(summary.entitiesCreated).toBe(2);
    expect(brain.entities.count()).toBe(2);
  });

  it('resolves and creates relations', async () => {
    const runner = new PipelineRunner(brain);
    runner.register(
      makeCollector('test', {
        entities: [
          { type: 'concept', name: 'A', source: { type: 'manual' } },
          { type: 'concept', name: 'B', source: { type: 'manual' } },
        ],
        relations: [
          {
            type: 'depends_on',
            sourceName: 'A',
            sourceType: 'concept',
            targetName: 'B',
            targetType: 'concept',
            source: { type: 'manual' },
          },
        ],
      }),
    );

    const summary = await runner.run(makeConfig());
    expect(summary.entitiesCreated).toBe(2);
    expect(summary.relationsCreated).toBe(1);
    expect(summary.relationsSkipped).toBe(0);
  });

  it('skips relations with unresolved entities', async () => {
    const runner = new PipelineRunner(brain);
    runner.register(
      makeCollector('test', {
        entities: [
          { type: 'concept', name: 'A', source: { type: 'manual' } },
        ],
        relations: [
          {
            type: 'depends_on',
            sourceName: 'A',
            sourceType: 'concept',
            targetName: 'NonExistent',
            targetType: 'concept',
            source: { type: 'manual' },
          },
        ],
      }),
    );

    const summary = await runner.run(makeConfig());
    expect(summary.relationsCreated).toBe(0);
    expect(summary.relationsSkipped).toBe(1);
  });

  it('is idempotent — second run does not duplicate', async () => {
    const collector = makeCollector('test', {
      entities: [
        { type: 'concept', name: 'A', observations: ['fact 1'], source: { type: 'manual' } },
      ],
      relations: [],
    });

    const runner = new PipelineRunner(brain);
    runner.register(collector);

    await runner.run(makeConfig());
    await runner.run(makeConfig());

    expect(brain.entities.count()).toBe(1);
    // Observations should be merged (deduplicated)
    const entity = brain.entities.findByName('A')[0];
    expect(entity.observations).toEqual(['fact 1']);
  });

  it('merges entities from multiple collectors', async () => {
    const runner = new PipelineRunner(brain);
    runner.register(
      makeCollector('git', {
        entities: [
          { type: 'person', name: 'Alice', observations: ['git author'], source: { type: 'git' } },
        ],
        relations: [],
      }),
    );
    runner.register(
      makeCollector('ast', {
        entities: [
          { type: 'file', name: 'index.ts', source: { type: 'ast' } },
        ],
        relations: [],
      }),
    );

    const summary = await runner.run(makeConfig());
    expect(summary.entitiesCreated).toBe(2);
    expect(summary.errors).toHaveLength(0);
  });

  it('catches collector errors without aborting', async () => {
    const runner = new PipelineRunner(brain);
    runner.register({
      name: 'broken',
      collect: async () => {
        throw new Error('collector failed');
      },
    });
    runner.register(
      makeCollector('good', {
        entities: [
          { type: 'concept', name: 'A', source: { type: 'manual' } },
        ],
        relations: [],
      }),
    );

    const summary = await runner.run(makeConfig());
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].collector).toBe('broken');
    expect(summary.entitiesCreated).toBe(1);
  });

  it('reports progress via callback', async () => {
    const events: string[] = [];
    const runner = new PipelineRunner(brain);
    runner.register(
      makeCollector('test', { entities: [], relations: [] }),
    );

    await runner.run(
      makeConfig({
        onProgress: (p) => events.push(p.stage),
      }),
    );

    expect(events).toContain('collecting');
    expect(events).toContain('storing');
    expect(events).toContain('done');
  });
});
