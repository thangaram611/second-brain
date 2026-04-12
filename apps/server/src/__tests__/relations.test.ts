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

describe('Relation routes', () => {
  async function createTwo() {
    const a = (await request(app).post('/api/entities').send({ type: 'concept', name: 'A' })).body;
    const b = (await request(app).post('/api/entities').send({ type: 'concept', name: 'B' })).body;
    return { a, b };
  }

  describe('POST /api/relations', () => {
    it('creates a relation', async () => {
      const { a, b } = await createTwo();

      const res = await request(app)
        .post('/api/relations')
        .send({ type: 'depends_on', sourceId: a.id, targetId: b.id })
        .expect(201);

      expect(res.body.type).toBe('depends_on');
      expect(res.body.sourceId).toBe(a.id);
      expect(res.body.targetId).toBe(b.id);
    });

    it('rejects if source entity missing', async () => {
      const { b } = await createTwo();

      const res = await request(app)
        .post('/api/relations')
        .send({ type: 'depends_on', sourceId: 'missing', targetId: b.id })
        .expect(400);

      expect(res.body.error).toContain('Source entity');
    });

    it('rejects if target entity missing', async () => {
      const { a } = await createTwo();

      const res = await request(app)
        .post('/api/relations')
        .send({ type: 'depends_on', sourceId: a.id, targetId: 'missing' })
        .expect(400);

      expect(res.body.error).toContain('Target entity');
    });

    it('rejects invalid relation type', async () => {
      const { a, b } = await createTwo();

      await request(app)
        .post('/api/relations')
        .send({ type: 'invalid_type', sourceId: a.id, targetId: b.id })
        .expect(400);
    });
  });

  describe('GET /api/relations/:id', () => {
    it('returns a relation', async () => {
      const { a, b } = await createTwo();
      const created = (
        await request(app).post('/api/relations').send({ type: 'depends_on', sourceId: a.id, targetId: b.id })
      ).body;

      const res = await request(app).get(`/api/relations/${created.id}`).expect(200);
      expect(res.body.id).toBe(created.id);
    });

    it('returns 404 for missing', async () => {
      await request(app).get('/api/relations/nonexistent').expect(404);
    });
  });

  describe('DELETE /api/relations/:id', () => {
    it('deletes a relation', async () => {
      const { a, b } = await createTwo();
      const created = (
        await request(app).post('/api/relations').send({ type: 'depends_on', sourceId: a.id, targetId: b.id })
      ).body;

      await request(app).delete(`/api/relations/${created.id}`).expect(204);
      await request(app).get(`/api/relations/${created.id}`).expect(404);
    });

    it('returns 404 for missing', async () => {
      await request(app).delete('/api/relations/nonexistent').expect(404);
    });
  });
});
