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

describe('BitemporalQueries', () => {
  describe('getEntitiesAsOf', () => {
    it('filters entities by eventTime', () => {
      brain.entities.create(makeEntity('Alpha', { eventTime: '2025-01-01T00:00:00Z' }));
      brain.entities.create(makeEntity('Beta', { eventTime: '2025-06-01T00:00:00Z' }));
      brain.entities.create(makeEntity('Gamma', { eventTime: '2026-01-01T00:00:00Z' }));

      const results = brain.temporal.getEntitiesAsOf({
        asOfEventTime: '2025-07-01T00:00:00Z',
      });

      expect(results).toHaveLength(2);
      const names = results.map((e) => e.name);
      expect(names).toContain('Alpha');
      expect(names).toContain('Beta');
      expect(names).not.toContain('Gamma');
    });

    it('filters entities by ingestTime', () => {
      // Create entities — ingestTime is auto-set to now()
      // We need to insert with raw SQL to control ingestTime
      const e1 = brain.entities.create(makeEntity('Old Knowledge'));
      const e2 = brain.entities.create(makeEntity('New Knowledge'));

      // Manually update ingest_time
      brain.storage.sqlite
        .prepare('UPDATE entities SET ingest_time = ? WHERE id = ?')
        .run('2025-01-01T00:00:00Z', e1.id);
      brain.storage.sqlite
        .prepare('UPDATE entities SET ingest_time = ? WHERE id = ?')
        .run('2026-06-01T00:00:00Z', e2.id);

      const results = brain.temporal.getEntitiesAsOf({
        asOfIngestTime: '2025-12-31T00:00:00Z',
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Old Knowledge');
    });

    it('filters by namespace', () => {
      brain.entities.create(makeEntity('Personal', { namespace: 'personal' }));
      brain.entities.create(makeEntity('Project', { namespace: 'project-x' }));

      const results = brain.temporal.getEntitiesAsOf({ namespace: 'personal' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Personal');
    });

    it('filters by entity types', () => {
      brain.entities.create(makeEntity('Concept A', { type: 'concept' }));
      brain.entities.create(makeEntity('Decision A', { type: 'decision' }));
      brain.entities.create(makeEntity('Fact A', { type: 'fact' }));

      const results = brain.temporal.getEntitiesAsOf({ types: ['concept', 'fact'] });
      expect(results).toHaveLength(2);
      const types = results.map((e) => e.type);
      expect(types).toContain('concept');
      expect(types).toContain('fact');
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        brain.entities.create(makeEntity(`Entity ${i}`));
      }

      const page1 = brain.temporal.getEntitiesAsOf({ limit: 2, offset: 0 });
      const page2 = brain.temporal.getEntitiesAsOf({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('getTimeline', () => {
    it('returns created entries within range', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
      const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();

      brain.entities.create(makeEntity('Today Entity'));

      const entries = brain.temporal.getTimeline({ from: yesterday, to: tomorrow });

      expect(entries.length).toBeGreaterThanOrEqual(1);
      const created = entries.filter((e) => e.changeType === 'created');
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(created[0].entityName).toBe('Today Entity');
    });

    it('distinguishes created vs updated entries', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
      const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();

      const entity = brain.entities.create(makeEntity('Evolving'));
      brain.entities.update(entity.id, { name: 'Evolved' });

      const entries = brain.temporal.getTimeline({ from: yesterday, to: tomorrow });

      const created = entries.filter((e) => e.changeType === 'created');
      const updated = entries.filter((e) => e.changeType === 'updated');

      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(updated.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes entries outside the time range', () => {
      brain.entities.create(makeEntity('In Range'));

      const farFuture = '2099-01-01T00:00:00Z';
      const farFuture2 = '2099-12-31T00:00:00Z';
      const entries = brain.temporal.getTimeline({ from: farFuture, to: farFuture2 });

      expect(entries).toHaveLength(0);
    });

    it('respects type filter', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
      const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();

      brain.entities.create(makeEntity('C1', { type: 'concept' }));
      brain.entities.create(makeEntity('D1', { type: 'decision' }));

      const entries = brain.temporal.getTimeline({
        from: yesterday,
        to: tomorrow,
        types: ['decision'],
      });

      expect(entries.every((e) => e.entityType === 'decision')).toBe(true);
    });
  });

  describe('searchAsOf', () => {
    it('combines FTS with temporal filters', () => {
      brain.entities.create(
        makeEntity('SQLite Optimization', {
          eventTime: '2025-01-01T00:00:00Z',
          observations: ['WAL mode improves concurrency'],
        }),
      );
      brain.entities.create(
        makeEntity('SQLite Security', {
          eventTime: '2026-06-01T00:00:00Z',
          observations: ['Use parameterized queries'],
        }),
      );

      const results = brain.temporal.searchAsOf('SQLite', {
        asOfEventTime: '2025-12-31T00:00:00Z',
      });

      expect(results).toHaveLength(1);
      expect(results[0].entity.name).toBe('SQLite Optimization');
    });

    it('returns empty for empty query', () => {
      brain.entities.create(makeEntity('Test'));
      expect(brain.temporal.searchAsOf('', {})).toHaveLength(0);
      expect(brain.temporal.searchAsOf('   ', {})).toHaveLength(0);
    });
  });
});
