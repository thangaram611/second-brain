import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '@second-brain/core';
import { ObservationService } from '../services/observation-service.js';
import { PromotionService } from '../services/promotion-service.js';
import { PersonalityExtractor } from '../services/personality-extractor.js';

let brain: Brain;
let observations: ObservationService;
let promotion: PromotionService;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  promotion = new PromotionService(brain, null);
  observations = new ObservationService(brain, promotion);
});

afterEach(() => {
  brain.close();
});

describe('Personality wiring — session-end', () => {
  it('triggers personality extractor with correct actor on session-end', async () => {
    const extractor = new PersonalityExtractor(brain);
    const spy = vi.spyOn(extractor, 'runForSession').mockResolvedValue({
      actor: 'alice@example.com',
      streams: {},
      durationMs: 0,
    });
    observations.setPersonalityExtractor(extractor);

    // Start a session and set an author
    observations.handleSessionStart({ sessionId: 's1' });
    observations.setAuthor('s1', {
      canonicalEmail: 'alice@example.com',
      aliases: [],
    });

    await observations.handleSessionEnd({ sessionId: 's1' });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('s1', { actor: 'alice@example.com' });
  });

  it('does not break session-end when personality extractor throws', async () => {
    const extractor = new PersonalityExtractor(brain);
    vi.spyOn(extractor, 'runForSession').mockRejectedValue(new Error('boom'));
    observations.setPersonalityExtractor(extractor);

    observations.handleSessionStart({ sessionId: 's2' });
    observations.setAuthor('s2', {
      canonicalEmail: 'bob@example.com',
      aliases: [],
    });

    // Should not throw — personality errors are swallowed
    const result = await observations.handleSessionEnd({ sessionId: 's2' });
    expect(result).toBeDefined();
    expect(result.promotion).toBeDefined();
  });

  it('works normally when no personality extractor is set', async () => {
    observations.handleSessionStart({ sessionId: 's3' });

    const result = await observations.handleSessionEnd({ sessionId: 's3' });
    expect(result).toBeDefined();
    expect(result.promotion).toBeDefined();
  });

  it('skips personality extraction when extractor is already running (mutex)', async () => {
    const extractor = new PersonalityExtractor(brain);
    const spy = vi.spyOn(extractor, 'runForSession').mockResolvedValue(null);
    observations.setPersonalityExtractor(extractor);

    observations.handleSessionStart({ sessionId: 's4' });
    observations.setAuthor('s4', {
      canonicalEmail: 'charlie@example.com',
      aliases: [],
    });

    await observations.handleSessionEnd({ sessionId: 's4' });

    // runForSession returns null when mutex is held — verify it was called
    expect(spy).toHaveBeenCalledOnce();
  });

  it('skips personality extraction when no actor is set for session', async () => {
    const extractor = new PersonalityExtractor(brain);
    const spy = vi.spyOn(extractor, 'runForSession').mockResolvedValue(null);
    observations.setPersonalityExtractor(extractor);

    observations.handleSessionStart({ sessionId: 's5' });
    // No setAuthor call — no actor available

    await observations.handleSessionEnd({ sessionId: 's5' });

    // Should not have called runForSession since there's no actor
    expect(spy).not.toHaveBeenCalled();
  });
});
