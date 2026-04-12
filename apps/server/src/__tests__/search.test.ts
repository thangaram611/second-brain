import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Brain } from '@second-brain/core';
import { createApp } from '../app.js';
import type { Express } from 'express';

let brain: Brain;
let app: Express;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  app = createApp(brain);
});

afterEach(() => {
  brain.close();
});

describe('Search routes', () => {
  describe('GET /api/search', () => {
    it('returns search results', async () => {
      await request(app).post('/api/entities').send({
        type: 'concept',
        name: 'CRDT conflict resolution',
        observations: ['Uses last-writer-wins semantics'],
      });
      await request(app).post('/api/entities').send({
        type: 'concept',
        name: 'Event sourcing',
      });

      const res = await request(app).get('/api/search?q=CRDT').expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].entity.name).toContain('CRDT');
      expect(res.body[0].score).toBeGreaterThan(0);
      expect(res.body[0].matchChannel).toBe('fulltext');
    });

    it('filters by type', async () => {
      await request(app).post('/api/entities').send({ type: 'concept', name: 'CRDT concept' });
      await request(app).post('/api/entities').send({ type: 'decision', name: 'CRDT decision' });

      const res = await request(app).get('/api/search?q=CRDT&types=concept').expect(200);

      for (const result of res.body) {
        expect(result.entity.type).toBe('concept');
      }
    });

    it('rejects missing query', async () => {
      await request(app).get('/api/search').expect(400);
    });
  });

  describe('GET /api/stats', () => {
    it('returns graph statistics', async () => {
      await request(app).post('/api/entities').send({ type: 'concept', name: 'A' });
      await request(app).post('/api/entities').send({ type: 'decision', name: 'B' });

      const res = await request(app).get('/api/stats').expect(200);

      expect(res.body.totalEntities).toBe(2);
      expect(res.body.entitiesByType.concept).toBe(1);
      expect(res.body.entitiesByType.decision).toBe(1);
      expect(res.body.namespaces).toContain('personal');
    });
  });

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
    });
  });
});
