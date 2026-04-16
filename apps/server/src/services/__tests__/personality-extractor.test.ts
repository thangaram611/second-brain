import { describe, it, expect, afterEach, vi } from 'vitest';
import { Brain } from '@second-brain/core';
import {
  PersonalityExtractor,
  type PersonalityStream,
  type PersonalityContext,
} from '../personality-extractor.js';

describe('PersonalityExtractor', () => {
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

  const mockStream: PersonalityStream = {
    name: 'test-stream',
    run: async () => ({ created: 2, updated: 1 }),
  };

  it('runs all registered streams and collects results', async () => {
    const extractor = new PersonalityExtractor(makeBrain(), { logger: silentLogger });
    const streamA: PersonalityStream = {
      name: 'stream-a',
      run: async () => ({ created: 3, updated: 0 }),
    };
    const streamB: PersonalityStream = {
      name: 'stream-b',
      run: async () => ({ created: 0, updated: 5 }),
    };
    extractor.registerStream(streamA);
    extractor.registerStream(streamB);

    const result = await extractor.run('user-1');

    expect(result.actor).toBe('user-1');
    expect(result.streams['stream-a']).toEqual({ created: 3, updated: 0 });
    expect(result.streams['stream-b']).toEqual({ created: 0, updated: 5 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('isolates stream failures — one stream failing does not affect others', async () => {
    const extractor = new PersonalityExtractor(makeBrain(), { logger: silentLogger });
    const failStream: PersonalityStream = {
      name: 'fail-stream',
      run: async () => {
        throw new Error('stream broke');
      },
    };
    extractor.registerStream(failStream);
    extractor.registerStream(mockStream);

    const result = await extractor.run('user-1');

    expect(result.streams['fail-stream']).toEqual({
      created: 0,
      updated: 0,
      error: 'stream broke',
    });
    expect(result.streams['test-stream']).toEqual({ created: 2, updated: 1 });
  });

  it('mutex: concurrent runs return early', async () => {
    const extractor = new PersonalityExtractor(makeBrain(), { logger: silentLogger });
    let resolveRun: (() => void) | undefined;
    const slowStream: PersonalityStream = {
      name: 'slow',
      run: () =>
        new Promise((resolve) => {
          resolveRun = () => resolve({ created: 1, updated: 0 });
        }),
    };
    extractor.registerStream(slowStream);

    const first = extractor.run('user-1');
    // Second call while first is in progress
    const second = await extractor.run('user-1');

    expect(second.streams).toEqual({});
    expect(second.durationMs).toBe(0);

    // Resolve the first run
    resolveRun?.();
    const firstResult = await first;
    expect(firstResult.streams['slow']).toEqual({ created: 1, updated: 0 });
  });

  it('runForSession skips if already running', async () => {
    const extractor = new PersonalityExtractor(makeBrain(), { logger: silentLogger });
    let resolveRun: (() => void) | undefined;
    const slowStream: PersonalityStream = {
      name: 'slow',
      run: () =>
        new Promise((resolve) => {
          resolveRun = () => resolve({ created: 1, updated: 0 });
        }),
    };
    extractor.registerStream(slowStream);

    const first = extractor.run('user-1');
    const sessionResult = await extractor.runForSession('sess-1', { actor: 'user-1' });

    expect(sessionResult).toBeNull();

    resolveRun?.();
    await first;
  });

  it('returns correct durationMs', async () => {
    const extractor = new PersonalityExtractor(makeBrain(), { logger: silentLogger });
    const delayStream: PersonalityStream = {
      name: 'delay',
      run: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ created: 0, updated: 0 }), 50);
        }),
    };
    extractor.registerStream(delayStream);

    const result = await extractor.run('user-1');
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('works with zero registered streams', async () => {
    const extractor = new PersonalityExtractor(makeBrain(), { logger: silentLogger });
    const result = await extractor.run('user-1');

    expect(result.actor).toBe('user-1');
    expect(result.streams).toEqual({});
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
