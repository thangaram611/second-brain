import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });

  // Seed test data
  brain.entities.create({
    type: 'concept',
    name: 'CRDT',
    observations: ['Conflict-free Replicated Data Types', 'Used in distributed systems'],
    tags: ['distributed', 'sync'],
    source: { type: 'manual' },
  });

  brain.entities.create({
    type: 'concept',
    name: 'Event Sourcing',
    observations: ['Store all changes as immutable events', 'Enables time travel debugging'],
    tags: ['architecture', 'data'],
    source: { type: 'manual' },
  });

  brain.entities.create({
    type: 'decision',
    name: 'Use SQLite for local storage',
    observations: ['Local-first requires embedded database', 'better-sqlite3 has good perf'],
    tags: ['database', 'architecture'],
    source: { type: 'manual' },
  });

  brain.entities.create({
    type: 'fact',
    name: 'API rate limit',
    observations: ['GitHub API allows 5000 requests per hour', 'Authenticated requests only'],
    namespace: 'project-x',
    source: { type: 'manual' },
  });
});

afterEach(() => {
  brain.close();
});

describe('SearchEngine', () => {
  describe('full-text search', () => {
    it('finds entities by name', () => {
      const results = brain.search.search({ query: 'CRDT' });
      expect(results).toHaveLength(1);
      expect(results[0].entity.name).toBe('CRDT');
      expect(results[0].matchChannel).toBe('fulltext');
    });

    it('finds entities by observation content', () => {
      const results = brain.search.search({ query: 'distributed' });
      expect(results).toHaveLength(1);
      expect(results[0].entity.name).toBe('CRDT');
    });

    it('finds entities by tag content', () => {
      const results = brain.search.search({ query: 'architecture' });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('returns multiple matches', () => {
      const results = brain.search.search({ query: 'database' });
      // Should match "Use SQLite for local storage" (observation mentions database)
      // and potentially via tags
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty for no match', () => {
      const results = brain.search.search({ query: 'xyznonexistent' });
      expect(results).toHaveLength(0);
    });

    it('returns empty for blank query', () => {
      const results = brain.search.search({ query: '   ' });
      expect(results).toHaveLength(0);
    });
  });

  describe('filters', () => {
    it('filters by namespace', () => {
      const results = brain.search.search({ query: 'API', namespace: 'project-x' });
      expect(results).toHaveLength(1);
      expect(results[0].entity.namespace).toBe('project-x');
    });

    it('filters by entity type', () => {
      const results = brain.search.search({ query: 'SQLite', types: ['decision'] });
      expect(results).toHaveLength(1);
      expect(results[0].entity.type).toBe('decision');
    });

    it('respects limit', () => {
      const results = brain.search.search({ query: 'e', limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('getStats', () => {
    it('returns overall stats', () => {
      const stats = brain.search.getStats();

      expect(stats.totalEntities).toBe(4);
      expect(stats.totalRelations).toBe(0);
      expect(stats.entitiesByType.concept).toBe(2);
      expect(stats.entitiesByType.decision).toBe(1);
      expect(stats.entitiesByType.fact).toBe(1);
      expect(stats.namespaces).toContain('personal');
      expect(stats.namespaces).toContain('project-x');
    });

    it('returns namespace-filtered stats', () => {
      const stats = brain.search.getStats('personal');

      expect(stats.totalEntities).toBe(3);
      expect(stats.entitiesByType.fact).toBeUndefined();
    });
  });
});
