import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Brain } from '@second-brain/core';
import { createApp } from '../app.js';
import { OwnershipService } from '../services/ownership-service.js';
import type { Express } from 'express';

let brain: Brain;
let app: Express;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  const ownership = new OwnershipService(brain, {
    simpleGit: () => ({
      async log(): Promise<string> {
        return 'alice@example.com\nbob@example.com\nalice@example.com\n';
      },
      async blame(): Promise<string> {
        return '';
      },
    }),
  });
  app = createApp(brain, { ownership });
});

afterEach(() => {
  brain.close();
});

describe('Query routes', () => {
  describe('GET /api/query/ownership', () => {
    it('returns 200 with an array', async () => {
      const res = await request(app)
        .get('/api/query/ownership')
        .query({ path: 'foo.ts' })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns results with correct OwnershipScore shape', async () => {
      const res = await request(app)
        .get('/api/query/ownership')
        .query({ path: 'foo.ts' })
        .expect(200);

      for (const entry of res.body) {
        expect(entry).toHaveProperty('actor');
        expect(entry).toHaveProperty('score');
        expect(entry).toHaveProperty('signals');
        expect(entry.signals).toHaveProperty('commits');
        expect(entry.signals).toHaveProperty('recencyWeightedBlameLines');
        expect(entry.signals).toHaveProperty('reviews');
        expect(entry.signals).toHaveProperty('testAuthorship');
        expect(entry.signals).toHaveProperty('codeownerMatch');
        expect(typeof entry.actor).toBe('string');
        expect(typeof entry.score).toBe('number');
      }
    });

    it('returns 400 when path param is missing', async () => {
      await request(app)
        .get('/api/query/ownership')
        .expect(400);
    });

    it('rejects unauthenticated request when bearer token is set', async () => {
      const brain2 = new Brain({ path: ':memory:', wal: false });
      const ownership2 = new OwnershipService(brain2, {
        simpleGit: () => ({
          async log(): Promise<string> {
            return '';
          },
          async blame(): Promise<string> {
            return '';
          },
        }),
      });
      const app2 = createApp(brain2, {
        ownership: ownership2,
        queryOptions: { bearerToken: 'secret' },
      });

      await request(app2)
        .get('/api/query/ownership')
        .query({ path: 'foo.ts' })
        .expect(401);

      await request(app2)
        .get('/api/query/ownership')
        .query({ path: 'foo.ts' })
        .set('Authorization', 'Bearer secret')
        .expect(200);

      brain2.close();
    });
  });
});
