import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BranchContext } from '@second-brain/types';
import { Brain } from '../brain.js';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function wipContext(branch: string): BranchContext {
  return { branch, status: 'wip', mrIid: null, mergedAt: null };
}

describe('Brain.flipBranchStatus', () => {
  it('updates entities and relations carrying the target branch; leaves others alone', () => {
    const a = brain.entities.create({
      type: 'file',
      name: 'src/a.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/a') },
      source: { type: 'watch', actor: 'alice@x' },
    });
    const b = brain.entities.create({
      type: 'file',
      name: 'src/b.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/a') },
      source: { type: 'watch', actor: 'alice@x' },
    });
    const c = brain.entities.create({
      type: 'file',
      name: 'src/c.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/b') },
      source: { type: 'watch', actor: 'bob@x' },
    });
    brain.relations.create({
      type: 'touches_file',
      sourceId: a.id,
      targetId: b.id,
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/a') },
      source: { type: 'watch', actor: 'alice@x' },
    });
    brain.relations.create({
      type: 'touches_file',
      sourceId: c.id,
      targetId: b.id,
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/b') },
      source: { type: 'watch', actor: 'bob@x' },
    });

    const result = brain.flipBranchStatus('feat/a', {
      status: 'merged',
      mergedAt: '2026-04-13T10:00:00.000Z',
      mrIid: 42,
    });

    expect(result.updatedEntities).toBe(2);
    expect(result.updatedRelations).toBe(1);

    const aRow = brain.entities.get(a.id);
    const bRow = brain.entities.get(b.id);
    const cRow = brain.entities.get(c.id);
    expect(aRow?.properties.branchContext).toMatchObject({
      branch: 'feat/a',
      status: 'merged',
      mergedAt: '2026-04-13T10:00:00.000Z',
      mrIid: 42,
    });
    expect(bRow?.properties.branchContext).toMatchObject({ status: 'merged' });
    expect(cRow?.properties.branchContext).toMatchObject({
      branch: 'feat/b',
      status: 'wip',
    });
  });

  it('updates a relation on branch A without mutating its cross-branch endpoints', () => {
    const onA = brain.entities.create({
      type: 'file',
      name: 'a.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/a') },
      source: { type: 'watch', actor: 'alice@x' },
    });
    const onB = brain.entities.create({
      type: 'file',
      name: 'b.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/b') },
      source: { type: 'watch', actor: 'bob@x' },
    });
    brain.relations.create({
      type: 'touches_file',
      sourceId: onA.id,
      targetId: onB.id,
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/a') },
      source: { type: 'watch', actor: 'alice@x' },
    });

    brain.flipBranchStatus('feat/a', { status: 'merged', mergedAt: '2026-04-13T10:00:00.000Z' });

    expect(brain.entities.get(onA.id)?.properties.branchContext).toMatchObject({ status: 'merged' });
    expect(brain.entities.get(onB.id)?.properties.branchContext).toMatchObject({ status: 'wip' });
  });

  it('is idempotent — re-flipping the same branch with the same patch updates same rows', () => {
    brain.entities.create({
      type: 'file',
      name: 'x.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/x') },
      source: { type: 'watch', actor: 'alice@x' },
    });

    const first = brain.flipBranchStatus('feat/x', { status: 'merged', mergedAt: '2026-04-13T10:00:00.000Z' });
    const second = brain.flipBranchStatus('feat/x', { status: 'merged', mergedAt: '2026-04-13T10:00:00.000Z' });

    expect(first.updatedEntities).toBe(1);
    expect(second.updatedEntities).toBe(1);
  });

  it('progresses wip → merged → abandoned and persists each status', () => {
    const e = brain.entities.create({
      type: 'file',
      name: 'y.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/y') },
      source: { type: 'watch', actor: 'alice@x' },
    });

    brain.flipBranchStatus('feat/y', { status: 'merged', mrIid: 7, mergedAt: '2026-04-13T10:00:00.000Z' });
    expect(brain.entities.get(e.id)?.properties.branchContext).toMatchObject({
      status: 'merged',
      mrIid: 7,
    });

    brain.flipBranchStatus('feat/y', { status: 'abandoned', mrIid: null, mergedAt: null });
    expect(brain.entities.get(e.id)?.properties.branchContext).toMatchObject({
      status: 'abandoned',
      mrIid: null,
      mergedAt: null,
    });
  });

  it('rejects empty branch names', () => {
    expect(() => brain.flipBranchStatus('', { status: 'merged' })).toThrow(/non-empty/);
  });
});
