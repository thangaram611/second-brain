import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAuthRouter } from '../auth.js';
import { loadDocState, saveDocState } from '../persistence.js';

const TEST_SECRET = 'test-relay-secret-2026';

// --- Auth endpoint tests ---

describe('Auth endpoint', () => {
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(createAuthRouter(TEST_SECRET));
  });

  it('returns a JWT for valid credentials', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ namespace: 'project-x', userName: 'alice', secret: TEST_SECRET })
      .expect(200);

    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
    expect(res.body.expiresIn).toBe(86_400);

    // Verify the token is valid
    const decoded = jwt.verify(res.body.token, TEST_SECRET);
    expect(typeof decoded).toBe('object');
    expect(decoded).not.toBeNull();
    if (typeof decoded === 'object' && decoded !== null) {
      expect('sub' in decoded && decoded.sub).toBe('alice');
      expect('namespace' in decoded && decoded.namespace).toBe('project-x');
      expect('permissions' in decoded && decoded.permissions).toEqual(['read', 'write']);
    }
  });

  it('rejects invalid secret with 401', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ namespace: 'project-x', userName: 'alice', secret: 'wrong-secret' })
      .expect(401);

    expect(res.body.error).toBe('Invalid secret');
  });

  it('rejects missing fields with 400', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ namespace: 'project-x' })
      .expect(400);

    expect(res.body.error).toBe('Invalid request body');
  });

  it('rejects empty namespace with 400', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ namespace: '', userName: 'alice', secret: TEST_SECRET })
      .expect(400);

    expect(res.body.error).toBe('Invalid request body');
  });
});

// --- Persistence tests ---

describe('Persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-persist-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads Y.Doc state', () => {
    // Create a doc with some data
    const doc1 = new Y.Doc();
    const map = doc1.getMap('entities');
    map.set('entity-1', new Y.Map([['name', 'Test Entity']]));

    // Save to disk
    saveDocState(tmpDir, 'test-ns', doc1);

    // Verify file exists
    expect(fs.existsSync(path.join(tmpDir, 'test-ns.ystate'))).toBe(true);

    // Load into a fresh doc
    const doc2 = new Y.Doc();
    loadDocState(tmpDir, 'test-ns', doc2);

    const loaded = doc2.getMap('entities');
    const entityMap = loaded.get('entity-1');
    expect(entityMap).toBeDefined();
    if (entityMap instanceof Y.Map) {
      expect(entityMap.get('name')).toBe('Test Entity');
    }

    doc1.destroy();
    doc2.destroy();
  });

  it('loadDocState is a no-op for missing files', () => {
    const doc = new Y.Doc();
    // Should not throw
    loadDocState(tmpDir, 'nonexistent', doc);
    expect(doc.getMap('entities').size).toBe(0);
    doc.destroy();
  });

  it('creates persist directory if missing', () => {
    const nested = path.join(tmpDir, 'deep', 'nested');
    const doc = new Y.Doc();
    doc.getMap('meta').set('version', 1);

    saveDocState(nested, 'my-ns', doc);

    expect(fs.existsSync(path.join(nested, 'my-ns.ystate'))).toBe(true);
    doc.destroy();
  });
});
