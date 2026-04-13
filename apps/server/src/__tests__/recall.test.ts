import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Brain } from '@second-brain/core';
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

describe('session-start context block', () => {
  it('returns contextBlock with recently-accessed personal entities', async () => {
    // Seed a personal entity.
    const entity = brain.entities.create({
      type: 'decision',
      name: 'Use pnpm',
      namespace: 'personal',
      observations: ['Workspaces work well here'],
      source: { type: 'conversation' },
    });
    brain.entities.touch(entity.id);

    const res = await request(app)
      .post('/api/observe/session-start')
      .send({ sessionId: 'ctx1' })
      .expect(201);

    expect(res.body.contextBlock).toContain('Use pnpm');
    expect(res.body.contextBlock).toContain(entity.id);
  });

  it('returns empty contextBlock when no personal entities exist', async () => {
    const res = await request(app)
      .post('/api/observe/session-start')
      .send({ sessionId: 'ctx2' })
      .expect(201);
    expect(res.body.contextBlock).toBe('');
  });
});
