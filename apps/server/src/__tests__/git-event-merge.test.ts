import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Brain } from '@second-brain/core';
import type { BranchContext } from '@second-brain/types';
import { createApp } from '../app.js';
import { ObservationService } from '../services/observation-service.js';
import { PromotionService } from '../services/promotion-service.js';
import type { Express } from 'express';

let brain: Brain;
let app: Express;
let observations: ObservationService;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  const promotion = new PromotionService(brain, null);
  observations = new ObservationService(brain, promotion);
  app = createApp(brain, { observations });
});

afterEach(() => {
  brain.close();
});

function wipContext(branch: string): BranchContext {
  return { branch, status: 'wip', mrIid: null, mergedAt: null };
}

describe('POST /api/observe/git-event — merge flip', () => {
  it('flips the merged (source) branch to status=merged when payload carries mergedBranch', async () => {
    const file = brain.entities.create({
      type: 'file',
      name: 'src/a.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/done') },
      source: { type: 'watch', actor: 'alice@x' },
    });

    await request(app)
      .post('/api/observe/git-event')
      .send({
        repo: '/tmp/repo',
        namespace: 'proj',
        kind: 'merge',
        branch: 'main',
        mergedBranch: 'feat/done',
        headSha: 'abc123',
        timestamp: '2026-04-13T10:00:00.000Z',
      })
      .expect(201);

    const after = brain.entities.get(file.id);
    const ctx = (after?.properties as Record<string, unknown>).branchContext as Record<string, unknown>;
    expect(ctx.status).toBe('merged');
    expect(ctx.mergedAt).toBe('2026-04-13T10:00:00.000Z');
    expect(observations.counters.branch_flips_total).toBe(1);
    expect(observations.counters.branch_flips_failed).toBe(0);
  });

  it('does NOT flip when mergedBranch is missing (fast-forward with unresolved source)', async () => {
    const file = brain.entities.create({
      type: 'file',
      name: 'src/b.ts',
      namespace: 'proj',
      properties: { branchContext: wipContext('feat/unknown') },
      source: { type: 'watch', actor: 'alice@x' },
    });

    await request(app)
      .post('/api/observe/git-event')
      .send({
        repo: '/tmp/repo',
        namespace: 'proj',
        kind: 'merge',
        branch: 'main',
        headSha: 'def456',
      })
      .expect(201);

    const after = brain.entities.get(file.id);
    const ctx = (after?.properties as Record<string, unknown>).branchContext as Record<string, unknown>;
    expect(ctx.status).toBe('wip');
    expect(observations.counters.branch_flips_total).toBe(0);
  });

  it('is a no-op flip when the mergedBranch has no WIP entities — still returns 201', async () => {
    // No entities exist with branch_context_branch='feat/empty'.
    await request(app)
      .post('/api/observe/git-event')
      .send({
        repo: '/tmp/repo',
        namespace: 'proj',
        kind: 'merge',
        branch: 'main',
        mergedBranch: 'feat/empty',
        headSha: 'ghi789',
      })
      .expect(201);

    // Counter only bumps when >0 rows were touched.
    expect(observations.counters.branch_flips_total).toBe(0);
    expect(observations.counters.branch_flips_failed).toBe(0);
  });
});
