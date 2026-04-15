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

function ctx(branch: string, status: BranchContext['status'] = 'wip'): BranchContext {
  return { branch, status, mrIid: null, mergedAt: null };
}

function seedFileEdit(opts: {
  filename: string;
  branch: string;
  actor: string;
  namespace?: string;
  status?: BranchContext['status'];
}): { fileId: string; eventId: string } {
  const ns = opts.namespace ?? 'proj';
  const bc = ctx(opts.branch, opts.status);
  // The file entity itself also carries branchContext — mirrors what
  // observation-service does on handleFileChange.
  const existingMatches = brain.entities.findByName(opts.filename, ns);
  let file = existingMatches.find((e) => e.type === 'file');
  if (!file) {
    file = brain.entities.create({
      type: 'file',
      name: opts.filename,
      namespace: ns,
      properties: { branchContext: bc },
      source: { type: 'watch', actor: opts.actor },
    });
  } else {
    const updated = brain.entities.update(file.id, {
      properties: { ...(file.properties ?? {}), branchContext: bc },
    });
    if (updated) file = updated;
  }
  const event = brain.entities.create({
    type: 'event',
    name: `file-edit:${opts.branch}:${opts.actor}:${Math.random()}`,
    namespace: ns,
    properties: { branchContext: bc },
    source: { type: 'watch', actor: opts.actor },
  });
  brain.relations.create({
    type: 'touches_file',
    sourceId: event.id,
    targetId: file.id,
    namespace: ns,
    properties: { branchContext: bc },
    source: { type: 'watch', actor: opts.actor },
  });
  return { fileId: file.id, eventId: event.id };
}

describe('Brain.findParallelWork', () => {
  it('detects two actors touching the same file on different WIP branches', () => {
    const { fileId } = seedFileEdit({ filename: 'src/core.ts', branch: 'feat/a', actor: 'alice@x' });
    seedFileEdit({ filename: 'src/core.ts', branch: 'fix/b', actor: 'bob@x' });

    const rows = brain.findParallelWork();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(fileId);
    expect(rows[0].entityName).toBe('src/core.ts');
    expect(rows[0].actors.sort()).toEqual(['alice@x', 'bob@x']);
    expect(rows[0].branches.sort()).toEqual(['feat/a', 'fix/b']);
  });

  it('returns no alert when only a single distinct actor is involved', () => {
    // Same actor on two different branches — not a collision for this user.
    seedFileEdit({ filename: 'src/solo.ts', branch: 'feat/one', actor: 'alice@x' });
    seedFileEdit({ filename: 'src/solo.ts', branch: 'feat/two', actor: 'alice@x' });

    expect(brain.findParallelWork()).toHaveLength(0);
  });

  it('excludes entities whose branch has been merged', () => {
    seedFileEdit({ filename: 'src/done.ts', branch: 'feat/merged', actor: 'alice@x' });
    seedFileEdit({ filename: 'src/done.ts', branch: 'feat/wip', actor: 'bob@x' });

    // Before merge: 2 WIP actors → 1 alert.
    expect(brain.findParallelWork()).toHaveLength(1);

    brain.flipBranchStatus('feat/merged', {
      status: 'merged',
      mergedAt: '2026-04-13T10:00:00.000Z',
    });

    // After merge: only 1 WIP actor remaining → no alert.
    expect(brain.findParallelWork()).toHaveLength(0);
  });
});
