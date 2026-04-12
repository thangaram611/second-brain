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

describe('Entity routes', () => {
  describe('POST /api/entities', () => {
    it('creates an entity', async () => {
      const res = await request(app)
        .post('/api/entities')
        .send({ type: 'concept', name: 'CRDT' })
        .expect(201);

      expect(res.body.id).toBeTruthy();
      expect(res.body.type).toBe('concept');
      expect(res.body.name).toBe('CRDT');
      expect(res.body.namespace).toBe('personal');
      expect(res.body.source.type).toBe('manual');
    });

    it('creates with observations and tags', async () => {
      const res = await request(app)
        .post('/api/entities')
        .send({
          type: 'fact',
          name: 'SQLite WAL mode',
          observations: ['Enables concurrent reads', 'Default in this project'],
          tags: ['database', 'sqlite'],
        })
        .expect(201);

      expect(res.body.observations).toHaveLength(2);
      expect(res.body.tags).toContain('database');
    });

    it('rejects invalid entity type', async () => {
      await request(app)
        .post('/api/entities')
        .send({ type: 'invalid', name: 'test' })
        .expect(400);
    });

    it('rejects missing name', async () => {
      await request(app)
        .post('/api/entities')
        .send({ type: 'concept' })
        .expect(400);
    });
  });

  describe('GET /api/entities', () => {
    it('lists entities sorted by updatedAt desc', async () => {
      await request(app).post('/api/entities').send({ type: 'concept', name: 'A' });
      await request(app).post('/api/entities').send({ type: 'concept', name: 'B' });

      const res = await request(app).get('/api/entities').expect(200);

      expect(res.body).toHaveLength(2);
      // Most recent first
      expect(res.body[0].name).toBe('B');
    });

    it('filters by type', async () => {
      await request(app).post('/api/entities').send({ type: 'concept', name: 'A' });
      await request(app).post('/api/entities').send({ type: 'decision', name: 'B' });

      const res = await request(app).get('/api/entities?type=concept').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].type).toBe('concept');
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/entities').send({ type: 'concept', name: `E${i}` });
      }

      const res = await request(app).get('/api/entities?limit=2').expect(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('GET /api/entities/:id', () => {
    it('returns entity with relations', async () => {
      const e1 = (await request(app).post('/api/entities').send({ type: 'concept', name: 'A' })).body;
      const e2 = (await request(app).post('/api/entities').send({ type: 'concept', name: 'B' })).body;

      await request(app).post('/api/relations').send({
        type: 'relates_to',
        sourceId: e1.id,
        targetId: e2.id,
      });

      const res = await request(app).get(`/api/entities/${e1.id}`).expect(200);

      expect(res.body.entity.id).toBe(e1.id);
      expect(res.body.outbound).toHaveLength(1);
      expect(res.body.inbound).toHaveLength(0);
    });

    it('returns 404 for missing entity', async () => {
      await request(app).get('/api/entities/nonexistent').expect(404);
    });
  });

  describe('PATCH /api/entities/:id', () => {
    it('updates entity fields', async () => {
      const created = (await request(app).post('/api/entities').send({ type: 'concept', name: 'Old' })).body;

      const res = await request(app)
        .patch(`/api/entities/${created.id}`)
        .send({ name: 'New', confidence: 0.5 })
        .expect(200);

      expect(res.body.name).toBe('New');
      expect(res.body.confidence).toBe(0.5);
    });

    it('returns 404 for missing entity', async () => {
      await request(app)
        .patch('/api/entities/nonexistent')
        .send({ name: 'test' })
        .expect(404);
    });
  });

  describe('DELETE /api/entities/:id', () => {
    it('deletes an entity', async () => {
      const created = (await request(app).post('/api/entities').send({ type: 'concept', name: 'Temp' })).body;

      await request(app).delete(`/api/entities/${created.id}`).expect(204);
      await request(app).get(`/api/entities/${created.id}`).expect(404);
    });

    it('returns 404 for missing entity', async () => {
      await request(app).delete('/api/entities/nonexistent').expect(404);
    });
  });

  describe('Observations', () => {
    it('adds an observation', async () => {
      const created = (await request(app).post('/api/entities').send({ type: 'concept', name: 'Test' })).body;

      const res = await request(app)
        .post(`/api/entities/${created.id}/observations`)
        .send({ observation: 'New fact' })
        .expect(200);

      expect(res.body.observations).toContain('New fact');
    });

    it('removes an observation', async () => {
      const created = (
        await request(app).post('/api/entities').send({
          type: 'concept',
          name: 'Test',
          observations: ['keep', 'remove'],
        })
      ).body;

      const res = await request(app)
        .delete(`/api/entities/${created.id}/observations`)
        .send({ observation: 'remove' })
        .expect(200);

      expect(res.body.observations).toEqual(['keep']);
    });
  });

  describe('GET /api/entities/:id/neighbors', () => {
    it('returns neighbors at depth 1', async () => {
      const a = (await request(app).post('/api/entities').send({ type: 'concept', name: 'A' })).body;
      const b = (await request(app).post('/api/entities').send({ type: 'concept', name: 'B' })).body;
      const c = (await request(app).post('/api/entities').send({ type: 'concept', name: 'C' })).body;

      await request(app).post('/api/relations').send({ type: 'relates_to', sourceId: a.id, targetId: b.id });
      await request(app).post('/api/relations').send({ type: 'relates_to', sourceId: b.id, targetId: c.id });

      const res = await request(app).get(`/api/entities/${a.id}/neighbors?depth=1`).expect(200);

      // Should include A (seed) and B (neighbor), but not C (depth 2)
      const names = res.body.entities.map((e: { name: string }) => e.name);
      expect(names).toContain('A');
      expect(names).toContain('B');
      expect(names).not.toContain('C');
    });
  });
});
