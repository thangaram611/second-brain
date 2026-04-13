import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Brain } from '@second-brain/core';
import { sessionNamespace } from '@second-brain/types';
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

describe('Observe routes', () => {
  describe('POST /api/observe/session-start', () => {
    it('creates a conversation entity in session namespace', async () => {
      const res = await request(app)
        .post('/api/observe/session-start')
        .send({ sessionId: 's1', cwd: '/tmp/x', tool: 'claude' })
        .expect(201);

      expect(res.body.namespace).toBe('session:s1');
      expect(res.body.conversationId).toBeTruthy();

      const list = brain.entities.list({ namespace: 'session:s1' });
      expect(list).toHaveLength(1);
      expect(list[0].type).toBe('conversation');
      expect(list[0].properties.cwd).toBe('/tmp/x');
    });

    it('is idempotent — second session-start reuses the conversation', async () => {
      const a = await request(app)
        .post('/api/observe/session-start')
        .send({ sessionId: 's2' })
        .expect(201);
      const b = await request(app)
        .post('/api/observe/session-start')
        .send({ sessionId: 's2' })
        .expect(201);
      expect(a.body.conversationId).toBe(b.body.conversationId);
      expect(brain.entities.list({ namespace: 'session:s2' })).toHaveLength(1);
    });
  });

  describe('POST /api/observe/prompt-submit', () => {
    it('appends observation and strips <private> blocks', async () => {
      await request(app).post('/api/observe/session-start').send({ sessionId: 's3' });
      await request(app)
        .post('/api/observe/prompt-submit')
        .send({
          sessionId: 's3',
          prompt: 'Deploy the service <private>DB_PASSWORD=hunter2</private> tomorrow',
        })
        .expect(200);

      const [conv] = brain.entities.list({ namespace: 'session:s3' });
      const joined = conv.observations.join('\n');
      expect(joined).not.toContain('hunter2');
      expect(joined).not.toContain('<private>');
      expect(joined).toContain('Deploy the service');
      expect(observations.counters.private_blocks_filtered).toBe(1);
    });

    it('autocreates conversation if session-start was not called', async () => {
      await request(app)
        .post('/api/observe/prompt-submit')
        .send({ sessionId: 'fresh', prompt: 'hello' })
        .expect(200);
      expect(brain.entities.list({ namespace: 'session:fresh' })).toHaveLength(1);
    });
  });

  describe('POST /api/observe/tool-use', () => {
    it('creates event entity with relations to files', async () => {
      await request(app).post('/api/observe/session-start').send({ sessionId: 's4' });
      const res = await request(app)
        .post('/api/observe/tool-use')
        .send({
          sessionId: 's4',
          toolName: 'Edit',
          phase: 'post',
          filePaths: ['/repo/a.ts', '/repo/b.ts'],
          durationMs: 15,
        })
        .expect(201);

      expect(res.body.eventId).toBeTruthy();
      const ns = sessionNamespace('s4');
      const events = brain.entities.findByType('event', ns);
      expect(events).toHaveLength(1);
      const files = brain.entities.findByType('file', ns);
      expect(files).toHaveLength(2);
      const outbound = brain.relations.getOutbound(res.body.eventId);
      // one decided_in to conversation + two 'uses' to files
      expect(outbound).toHaveLength(3);
    });
  });

  describe('POST /api/observe/session-end', () => {
    it('promotes decision entities out of the session namespace', async () => {
      const sessionId = 's5';
      const ns = sessionNamespace(sessionId);
      await request(app).post('/api/observe/session-start').send({ sessionId });
      // Seed a decision inside the session directly.
      brain.entities.create({
        type: 'decision',
        name: 'Use Postgres',
        namespace: ns,
        source: { type: 'conversation' },
      });

      const res = await request(app)
        .post('/api/observe/session-end')
        .send({ sessionId })
        .expect(200);

      expect(res.body.promotion.promotedEntities).toBe(1);
      expect(brain.entities.count('personal')).toBeGreaterThanOrEqual(1);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when burst exceeded for a single session', async () => {
      const brain2 = new Brain({ path: ':memory:', wal: false });
      const promotion = new PromotionService(brain2, null);
      const obs2 = new ObservationService(brain2, promotion);
      const app2 = createApp(brain2, {
        observations: obs2,
        observeOptions: { burst: 2, sustained: 0 },
      });

      await request(app2).post('/api/observe/session-start').send({ sessionId: 'rl' }).expect(201);
      await request(app2).post('/api/observe/prompt-submit').send({ sessionId: 'rl', prompt: 'a' }).expect(200);
      await request(app2).post('/api/observe/prompt-submit').send({ sessionId: 'rl', prompt: 'b' }).expect(429);
      expect(obs2.counters.hook_events_dropped_ratelimit).toBe(1);

      brain2.close();
    });
  });

  describe('bearer auth', () => {
    it('rejects missing bearer when token is set', async () => {
      const brain2 = new Brain({ path: ':memory:', wal: false });
      const promotion = new PromotionService(brain2, null);
      const obs2 = new ObservationService(brain2, promotion);
      const app2 = createApp(brain2, {
        observations: obs2,
        observeOptions: { bearerToken: 'secret' },
      });

      await request(app2).post('/api/observe/session-start').send({ sessionId: 'x' }).expect(401);
      await request(app2)
        .post('/api/observe/session-start')
        .set('Authorization', 'Bearer secret')
        .send({ sessionId: 'x' })
        .expect(201);

      brain2.close();
    });
  });

  describe('gc', () => {
    it('removes session namespaces older than retention', async () => {
      const brain2 = new Brain({ path: ':memory:', wal: false });
      const promotion = new PromotionService(brain2, null);
      const obs2 = new ObservationService(brain2, promotion, { retentionDays: 0 });

      brain2.entities.create({
        type: 'conversation',
        name: 'old-session',
        namespace: 'session:old',
        source: { type: 'conversation' },
      });
      // Force the updated_at into the past.
      brain2.storage.sqlite
        .prepare(`UPDATE entities SET updated_at = '2000-01-01T00:00:00Z' WHERE namespace = ?`)
        .run('session:old');

      const removed = obs2.gcExpiredSessions();
      expect(removed).toBe(1);
      expect(brain2.entities.count('session:old')).toBe(0);
      brain2.close();
    });
  });
});
