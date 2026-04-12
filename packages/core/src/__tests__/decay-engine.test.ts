import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import type { CreateEntityInput } from '@second-brain/types';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function makeEntity(
  name: string,
  overrides: Partial<CreateEntityInput> = {},
): CreateEntityInput {
  return {
    type: 'concept',
    name,
    source: { type: 'manual' },
    ...overrides,
  };
}

describe('DecayEngine', () => {
  describe('computeDecayedConfidence', () => {
    it('returns full confidence for just-accessed entities', () => {
      const entity = brain.entities.create(makeEntity('Fresh'));
      // Entity was just created so lastAccessedAt is now
      const decayed = brain.decay.computeDecayedConfidence(entity);
      expect(decayed).toBeCloseTo(1.0, 2);
    });

    it('returns reduced confidence for old entities', () => {
      const entity = brain.entities.create(makeEntity('Old Fact', { type: 'fact' }));
      // Fact decay rate: 0.01/day — make it 100 days old
      const hundredDaysAgo = new Date(Date.now() - 100 * 86_400_000).toISOString();
      brain.storage.sqlite
        .prepare('UPDATE entities SET last_accessed_at = ? WHERE id = ?')
        .run(hundredDaysAgo, entity.id);

      const refreshed = brain.entities.get(entity.id)!;
      const decayed = brain.decay.computeDecayedConfidence(refreshed);

      // e^(-0.01 * 100) = e^(-1) ≈ 0.368
      expect(decayed).toBeCloseTo(0.368, 1);
      expect(decayed).toBeLessThan(refreshed.confidence);
    });

    it('returns unchanged confidence for non-decaying types', () => {
      const person = brain.entities.create(makeEntity('Alice', { type: 'person' }));
      // Even with old access time, person type should not decay
      const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
      brain.storage.sqlite
        .prepare('UPDATE entities SET last_accessed_at = ? WHERE id = ?')
        .run(yearAgo, person.id);

      const refreshed = brain.entities.get(person.id)!;
      const decayed = brain.decay.computeDecayedConfidence(refreshed);
      expect(decayed).toBe(refreshed.confidence);
    });

    it('returns unchanged confidence for file type', () => {
      const file = brain.entities.create(makeEntity('main.ts', { type: 'file' }));
      const decayed = brain.decay.computeDecayedConfidence(file);
      expect(decayed).toBe(file.confidence);
    });

    it('returns unchanged confidence for symbol type', () => {
      const symbol = brain.entities.create(makeEntity('createBrain', { type: 'symbol' }));
      const decayed = brain.decay.computeDecayedConfidence(symbol);
      expect(decayed).toBe(symbol.confidence);
    });
  });

  describe('getStaleEntities', () => {
    it('returns entities below confidence threshold', () => {
      const e1 = brain.entities.create(makeEntity('Stale Fact', { type: 'fact' }));
      brain.entities.create(makeEntity('Fresh Concept', { type: 'concept' }));

      // Make the fact very old (300 days)
      const longAgo = new Date(Date.now() - 300 * 86_400_000).toISOString();
      brain.storage.sqlite
        .prepare('UPDATE entities SET last_accessed_at = ? WHERE id = ?')
        .run(longAgo, e1.id);

      const stale = brain.decay.getStaleEntities({ threshold: 0.5 });

      expect(stale.length).toBeGreaterThanOrEqual(1);
      expect(stale[0].id).toBe(e1.id);
      expect(stale[0].effectiveConfidence).toBeLessThan(0.5);
    });

    it('excludes non-decaying types from stale results', () => {
      const person = brain.entities.create(makeEntity('Bob', { type: 'person' }));

      // Make it old
      const longAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
      brain.storage.sqlite
        .prepare('UPDATE entities SET last_accessed_at = ? WHERE id = ?')
        .run(longAgo, person.id);

      const stale = brain.decay.getStaleEntities({ threshold: 0.5 });
      const ids = stale.map((e) => e.id);
      expect(ids).not.toContain(person.id);
    });

    it('respects namespace filter', () => {
      const e1 = brain.entities.create(makeEntity('S1', { type: 'fact', namespace: 'personal' }));
      const e2 = brain.entities.create(makeEntity('S2', { type: 'fact', namespace: 'project-x' }));

      const longAgo = new Date(Date.now() - 300 * 86_400_000).toISOString();
      brain.storage.sqlite
        .prepare('UPDATE entities SET last_accessed_at = ? WHERE id IN (?, ?)')
        .run(longAgo, e1.id, e2.id);

      const stale = brain.decay.getStaleEntities({
        threshold: 0.5,
        namespace: 'personal',
      });

      const namespaces = stale.map((e) => e.namespace);
      expect(namespaces.every((n) => n === 'personal')).toBe(true);
    });

    it('respects type filter', () => {
      const fact = brain.entities.create(makeEntity('F1', { type: 'fact' }));
      const convo = brain.entities.create(makeEntity('C1', { type: 'conversation' }));

      const longAgo = new Date(Date.now() - 300 * 86_400_000).toISOString();
      brain.storage.sqlite.exec(
        `UPDATE entities SET last_accessed_at = '${longAgo}'`,
      );

      const stale = brain.decay.getStaleEntities({
        threshold: 0.5,
        types: ['fact'],
      });

      expect(stale.every((e) => e.type === 'fact')).toBe(true);
    });

    it('sorts by effective confidence ascending', () => {
      // Create entities with different types (different decay rates)
      brain.entities.create(makeEntity('Fact', { type: 'fact' })); // rate: 0.01
      brain.entities.create(makeEntity('Convo', { type: 'conversation' })); // rate: 0.05

      const longAgo = new Date(Date.now() - 100 * 86_400_000).toISOString();
      brain.storage.sqlite.exec(
        `UPDATE entities SET last_accessed_at = '${longAgo}'`,
      );

      const stale = brain.decay.getStaleEntities({ threshold: 1.0 });

      if (stale.length >= 2) {
        expect(stale[0].effectiveConfidence).toBeLessThanOrEqual(stale[1].effectiveConfidence);
      }
    });
  });

  describe('runOnce', () => {
    it('returns a valid DecayRunResult', () => {
      brain.entities.create(makeEntity('Test'));
      const result = brain.decay.runOnce();

      expect(result.timestamp).toBeTruthy();
      expect(result.runDurationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.staleCount).toBe('number');
    });
  });

  describe('start/stop', () => {
    it('can start and stop without error', () => {
      brain.decay.start();
      brain.decay.stop();
    });

    it('is idempotent', () => {
      brain.decay.start();
      brain.decay.start(); // should not throw
      brain.decay.stop();
      brain.decay.stop(); // should not throw
    });
  });
});
