import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Brain } from '@second-brain/core';
import { SyncManager } from '@second-brain/sync';
import { createApp } from '../app.js';
import { syncRoutes } from '../routes/sync.js';
import type { Express } from 'express';

let brain: Brain;
let syncManager: SyncManager;
let app: Express;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  syncManager = new SyncManager(brain.entities, brain.relations);
  app = createApp(brain, syncManager);
});

afterEach(() => {
  syncManager.destroy();
  brain.close();
});

describe('Sync routes', () => {
  describe('GET /api/sync/status', () => {
    it('returns empty array when no namespaces are synced', async () => {
      const res = await request(app).get('/api/sync/status').expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/sync/status/:namespace', () => {
    it('returns 404 for unknown namespace', async () => {
      const res = await request(app)
        .get('/api/sync/status/unknown-ns')
        .expect(404);
      expect(res.body.error).toBe('Namespace not synced');
    });
  });

  describe('POST /api/sync/join', () => {
    it('rejects personal namespace with 400', async () => {
      const res = await request(app)
        .post('/api/sync/join')
        .send({
          namespace: 'personal',
          relayUrl: 'ws://localhost:7421',
        })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it('rejects missing fields with 400', async () => {
      const res = await request(app)
        .post('/api/sync/join')
        .send({ namespace: 'project-x' })
        .expect(400);

      expect(res.body).toBeDefined();
    });

    it('rejects invalid relay URL with 400', async () => {
      const res = await request(app)
        .post('/api/sync/join')
        .send({
          namespace: 'project-x',
          relayUrl: 'not-a-url',
        })
        .expect(400);

      expect(res.body).toBeDefined();
    });

    it('rejects non-websocket relay URLs with 400', async () => {
      const res = await request(app)
        .post('/api/sync/join')
        .send({
          namespace: 'project-x',
          relayUrl: 'https://localhost:7421',
        })
        .expect(400);

      expect(res.body).toBeDefined();
    });

    // The server mints the relay JWT itself — clients no longer send a token.
    it('mints a token server-side and joins when a relay secret is configured', async () => {
      const bareApp = express();
      bareApp.use(express.json());
      bareApp.use(syncRoutes(syncManager, { relayAuthSecret: 'test-relay-secret' }));

      const res = await request(bareApp)
        .post('/api/sync/join')
        .send({ namespace: 'project-x', relayUrl: 'ws://localhost:7421' })
        .expect(200);

      // join() returns synchronously with a 'connecting' status; the background
      // provider connection to the (absent) relay is torn down in afterEach.
      expect(res.body.namespace).toBe('project-x');
      expect(res.body.state).toBe('connecting');
    });

    it('returns 503 when no relay secret is configured', async () => {
      const saved = process.env.RELAY_AUTH_SECRET;
      delete process.env.RELAY_AUTH_SECRET;
      try {
        const bareApp = express();
        bareApp.use(express.json());
        bareApp.use(syncRoutes(syncManager, {}));

        const res = await request(bareApp)
          .post('/api/sync/join')
          .send({ namespace: 'project-x', relayUrl: 'ws://localhost:7421' })
          .expect(503);

        expect(res.body.error).toMatch(/RELAY_AUTH_SECRET/);
      } finally {
        if (saved === undefined) delete process.env.RELAY_AUTH_SECRET;
        else process.env.RELAY_AUTH_SECRET = saved;
      }
    });
  });

  describe('POST /api/sync/leave', () => {
    it('leaves a namespace (even if not joined)', async () => {
      const res = await request(app)
        .post('/api/sync/leave')
        .send({ namespace: 'project-x' })
        .expect(200);

      expect(res.body.left).toBe('project-x');
    });

    it('rejects missing namespace with 400', async () => {
      await request(app)
        .post('/api/sync/leave')
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/sync/peers/:namespace', () => {
    it('returns empty array for unsynced namespace', async () => {
      const res = await request(app)
        .get('/api/sync/peers/unknown-ns')
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });
});

describe('Sync hooks in entity routes', () => {
  it('entity CRUD still works with syncManager wired', async () => {
    // Create
    const createRes = await request(app)
      .post('/api/entities')
      .send({
        type: 'concept',
        name: 'Sync Test Entity',
        namespace: 'personal',
        observations: ['A test observation'],
      })
      .expect(201);

    const entityId = createRes.body.id;
    expect(createRes.body.name).toBe('Sync Test Entity');

    // Read
    const getRes = await request(app)
      .get(`/api/entities/${entityId}`)
      .expect(200);
    expect(getRes.body.entity.name).toBe('Sync Test Entity');

    // Update
    const updateRes = await request(app)
      .patch(`/api/entities/${entityId}`)
      .send({ name: 'Updated Sync Test' })
      .expect(200);
    expect(updateRes.body.name).toBe('Updated Sync Test');

    // Add observation
    const obsRes = await request(app)
      .post(`/api/entities/${entityId}/observations`)
      .send({ observation: 'Another observation' })
      .expect(200);
    expect(obsRes.body.observations).toContain('Another observation');

    // Delete
    await request(app)
      .delete(`/api/entities/${entityId}`)
      .expect(204);

    // Verify deleted
    await request(app)
      .get(`/api/entities/${entityId}`)
      .expect(404);
  });

  it('relation CRUD still works with syncManager wired', async () => {
    // Create two entities
    const e1 = await request(app)
      .post('/api/entities')
      .send({ type: 'concept', name: 'Entity A' })
      .expect(201);
    const e2 = await request(app)
      .post('/api/entities')
      .send({ type: 'concept', name: 'Entity B' })
      .expect(201);

    // Create relation
    const relRes = await request(app)
      .post('/api/relations')
      .send({
        type: 'relates_to',
        sourceId: e1.body.id,
        targetId: e2.body.id,
      })
      .expect(201);

    expect(relRes.body.type).toBe('relates_to');

    // Delete relation
    await request(app)
      .delete(`/api/relations/${relRes.body.id}`)
      .expect(204);
  });
});
