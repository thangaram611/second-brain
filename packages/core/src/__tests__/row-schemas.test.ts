import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../brain.js';
import {
  parseEntityRow,
  parseRelationRow,
  parseEntityRowSafe,
  EntityRowSchema,
} from '../temporal/row-schemas.js';
import type { Entity } from '@second-brain/types';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function rawEntityRow(id: string): unknown {
  return brain.storage.sqlite.prepare('SELECT * FROM entities WHERE id = ?').get(id);
}

function rawRelationRow(id: string): unknown {
  return brain.storage.sqlite.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

describe('row-schemas', () => {
  describe('parseEntityRow', () => {
    it('produces a value deep-equal to the Drizzle path (brain.entities.get)', () => {
      const created = brain.entities.create({
        type: 'decision',
        name: 'Use ULIDs',
        namespace: 'team-a',
        observations: ['chosen for sortability', 'k-ordered'],
        properties: { rationale: 'monotonic' },
        confidence: 0.8,
        source: { type: 'manual', ref: 'rfc-1', actor: 'alice' },
        tags: ['ids', 'storage'],
      });

      const fromDrizzle = brain.entities.get(created.id);
      const fromRaw = parseEntityRow(rawEntityRow(created.id));

      expect(fromRaw).toEqual(fromDrizzle);
    });

    it('falls back lastAccessedAt to createdAt when last_accessed_at is NULL', () => {
      const created = brain.entities.create({
        type: 'concept',
        name: 'NullAccess',
        source: { type: 'manual' },
      });
      brain.storage.sqlite
        .prepare('UPDATE entities SET last_accessed_at = NULL WHERE id = ?')
        .run(created.id);

      const parsed = parseEntityRow(rawEntityRow(created.id));
      expect(parsed.lastAccessedAt).toBe(parsed.createdAt);
    });

    it('throws on an invalid entity type', () => {
      const created = brain.entities.create({
        type: 'concept',
        name: 'BadType',
        source: { type: 'manual' },
      });
      brain.storage.sqlite
        .prepare('UPDATE entities SET type = ? WHERE id = ?')
        .run('not-a-real-type', created.id);

      expect(() => parseEntityRow(rawEntityRow(created.id))).toThrow();
    });

    it('throws when observations is not a JSON string array', () => {
      const created = brain.entities.create({
        type: 'concept',
        name: 'BadObs',
        source: { type: 'manual' },
      });
      // A JSON object, not the expected string[]
      brain.storage.sqlite
        .prepare('UPDATE entities SET observations = ? WHERE id = ?')
        .run('{"not":"an array"}', created.id);

      expect(() => parseEntityRow(rawEntityRow(created.id))).toThrow();
    });
  });

  describe('parseEntityRowSafe', () => {
    it('returns the Entity for a valid row', () => {
      const created = brain.entities.create({
        type: 'concept',
        name: 'Valid',
        source: { type: 'manual' },
      });
      const parsed: Entity | null = parseEntityRowSafe(rawEntityRow(created.id));
      expect(parsed).not.toBeNull();
      expect(parsed?.id).toBe(created.id);
    });

    it('returns null for a malformed row instead of throwing', () => {
      const created = brain.entities.create({
        type: 'concept',
        name: 'WillBreak',
        source: { type: 'manual' },
      });
      brain.storage.sqlite
        .prepare('UPDATE entities SET type = ? WHERE id = ?')
        .run('bogus', created.id);

      expect(parseEntityRowSafe(rawEntityRow(created.id))).toBeNull();
    });

    it('matches EntityRowSchema.safeParse success flag', () => {
      const created = brain.entities.create({
        type: 'concept',
        name: 'SafeParse',
        source: { type: 'manual' },
      });
      const result = EntityRowSchema.safeParse(rawEntityRow(created.id));
      expect(result.success).toBe(true);
    });
  });

  describe('parseRelationRow', () => {
    it('produces a value deep-equal to the Drizzle path (brain.relations.get)', () => {
      const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
      const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
      const created = brain.relations.create({
        type: 'depends_on',
        sourceId: a.id,
        targetId: b.id,
        namespace: 'team-a',
        properties: { reason: 'build order' },
        confidence: 0.9,
        weight: 2,
        bidirectional: true,
        source: { type: 'manual', ref: 'commit-1', actor: 'bob' },
      });

      const fromDrizzle = brain.relations.get(created.id);
      const fromRaw = parseRelationRow(rawRelationRow(created.id));

      expect(fromRaw).toEqual(fromDrizzle);
    });

    it('coerces sqlite 0/1 bidirectional into a boolean', () => {
      const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
      const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
      const created = brain.relations.create({
        type: 'relates_to',
        sourceId: a.id,
        targetId: b.id,
        bidirectional: false,
        source: { type: 'manual' },
      });

      const row = brain.storage.sqlite
        .prepare('SELECT bidirectional FROM relations WHERE id = ?')
        .get(created.id);
      // Stored as integer 0
      expect(row).toEqual({ bidirectional: 0 });

      const parsed = parseRelationRow(rawRelationRow(created.id));
      expect(parsed.bidirectional).toBe(false);
    });

    it('throws on an invalid relation type', () => {
      const a = brain.entities.create({ type: 'concept', name: 'A', source: { type: 'manual' } });
      const b = brain.entities.create({ type: 'concept', name: 'B', source: { type: 'manual' } });
      const created = brain.relations.create({
        type: 'relates_to',
        sourceId: a.id,
        targetId: b.id,
        source: { type: 'manual' },
      });
      brain.storage.sqlite
        .prepare('UPDATE relations SET type = ? WHERE id = ?')
        .run('not-a-relation', created.id);

      expect(() => parseRelationRow(rawRelationRow(created.id))).toThrow();
    });
  });
});
