import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { verifyRelayToken } from '../server.js';
import { loadDocState, saveDocState } from '../persistence.js';

const TEST_SECRET = 'test-relay-secret-2026';

// --- Token round-trip tests ---
// Minting moved to the API server (@second-brain/sync `signRelayToken`); the
// relay only verifies. Issue tokens directly with jwt.sign to exercise
// verifyRelayToken without depending on the (removed) /auth/token endpoint.

describe('Relay token round-trip', () => {
  function issueToken(namespace: string, userName: string): string {
    return jwt.sign(
      { sub: userName, namespace, permissions: ['read', 'write'] },
      TEST_SECRET,
      { expiresIn: 86_400 },
    );
  }

  it('verifies a freshly issued token through the shared schema', () => {
    const token = issueToken('project-x', 'alice');

    const payload = verifyRelayToken(token, TEST_SECRET, 'project-x');

    expect(payload.sub).toBe('alice');
    expect(payload.namespace).toBe('project-x');
    expect(payload.permissions).toEqual(['read', 'write']);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('throws when the token namespace does not match the document', () => {
    const token = issueToken('project-x', 'alice');

    expect(() => verifyRelayToken(token, TEST_SECRET, 'wrong-ns')).toThrow(
      /does not match document/,
    );
  });

  it('throws on an invalid signature', () => {
    expect(() => verifyRelayToken('garbage', TEST_SECRET, 'project-x')).toThrow(
      'Invalid or expired token',
    );
  });

  it('rejects a token missing required payload fields via the schema guard', () => {
    // Hand-build a token without `permissions` — proves the issuer and verifier
    // share one canonical schema that rejects malformed payloads.
    const token = jwt.sign({ sub: 'mallory', namespace: 'project-x' }, TEST_SECRET, {
      expiresIn: 86_400,
    });

    expect(() => verifyRelayToken(token, TEST_SECRET, 'project-x')).toThrow(
      'Token payload does not match expected schema',
    );
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

  it('saves and loads Y.Doc state', async () => {
    // Create a doc with some data
    const doc1 = new Y.Doc();
    const map = doc1.getMap('entities');
    map.set('entity-1', new Y.Map([['name', 'Test Entity']]));

    // Save to disk
    await saveDocState(tmpDir, 'test-ns', doc1);

    // Verify file exists
    expect(fs.existsSync(path.join(tmpDir, 'test-ns.ystate'))).toBe(true);

    // Load into a fresh doc
    const doc2 = new Y.Doc();
    await loadDocState(tmpDir, 'test-ns', doc2);

    const loaded = doc2.getMap('entities');
    const entityMap = loaded.get('entity-1');
    expect(entityMap).toBeDefined();
    if (entityMap instanceof Y.Map) {
      expect(entityMap.get('name')).toBe('Test Entity');
    }

    doc1.destroy();
    doc2.destroy();
  });

  it('loadDocState is a no-op for missing files', async () => {
    const doc = new Y.Doc();
    // Should not throw
    await loadDocState(tmpDir, 'nonexistent', doc);
    expect(doc.getMap('entities').size).toBe(0);
    doc.destroy();
  });

  it('creates persist directory if missing', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested');
    const doc = new Y.Doc();
    doc.getMap('meta').set('version', 1);

    await saveDocState(nested, 'my-ns', doc);

    expect(fs.existsSync(path.join(nested, 'my-ns.ystate'))).toBe(true);
    doc.destroy();
  });

  it('rejects (does not silently swallow) when the target is unwritable', async () => {
    // Make persistDir's parent component a regular file, so mkdir/write must fail.
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    const badDir = path.join(blocker, 'subdir');

    const doc = new Y.Doc();
    doc.getMap('meta').set('version', 1);

    await expect(saveDocState(badDir, 'my-ns', doc)).rejects.toThrow();
    doc.destroy();
  });
});
