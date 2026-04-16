import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CustomProviderMappingSchema, extractField } from '../providers/custom-provider-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const giteaTemplate = JSON.parse(
  readFileSync(join(__dirname, '..', 'providers', 'templates', 'gitea.json'), 'utf-8'),
);

describe('CustomProviderMappingSchema', () => {
  it('parses the Gitea template without errors', () => {
    const result = CustomProviderMappingSchema.parse(giteaTemplate);
    expect(result.name).toBe('gitea');
    expect(result.version).toBe(1);
    expect(result.verification.kind).toBe('hmac');
    expect(result.eventTypeHeader).toBe('x-gitea-event');
    expect(result.mappings.pull_request).toBeDefined();
  });

  it('accepts a minimal token-based provider', () => {
    const minimal = {
      name: 'forgejo',
      version: 1,
      verification: { kind: 'token', header: 'x-forgejo-token' },
      eventTypeHeader: 'x-forgejo-event',
      mappings: {
        pull_request: {
          action: '$.action',
          number: '$.number',
          title: '$.title',
          sourceBranch: '$.head_branch',
          targetBranch: '$.base_branch',
          authorLogin: '$.user.login',
        },
      },
    };
    const result = CustomProviderMappingSchema.parse(minimal);
    expect(result.verification.kind).toBe('token');
    expect(result.mappings.pull_request?.action).toBe('$.action');
  });

  it('defaults hmac algorithm to sha256 and prefix to empty string', () => {
    const data = {
      name: 'test',
      version: 1,
      verification: { kind: 'hmac', header: 'x-sig' },
      eventTypeHeader: 'x-event',
      mappings: {},
    };
    const result = CustomProviderMappingSchema.parse(data);
    if (result.verification.kind === 'hmac') {
      expect(result.verification.algorithm).toBe('sha256');
      expect(result.verification.prefix).toBe('');
    }
  });

  it('rejects missing name', () => {
    const bad = {
      version: 1,
      verification: { kind: 'token', header: 'x-tok' },
      eventTypeHeader: 'x-event',
      mappings: {},
    };
    expect(() => CustomProviderMappingSchema.parse(bad)).toThrow();
  });

  it('rejects invalid version', () => {
    const bad = {
      name: 'test',
      version: 2,
      verification: { kind: 'token', header: 'x-tok' },
      eventTypeHeader: 'x-event',
      mappings: {},
    };
    expect(() => CustomProviderMappingSchema.parse(bad)).toThrow();
  });

  it('rejects empty header in verification', () => {
    const bad = {
      name: 'test',
      version: 1,
      verification: { kind: 'token', header: '' },
      eventTypeHeader: 'x-event',
      mappings: {},
    };
    expect(() => CustomProviderMappingSchema.parse(bad)).toThrow();
  });

  it('rejects PR mapping with missing required fields', () => {
    const bad = {
      name: 'test',
      version: 1,
      verification: { kind: 'token', header: 'x-tok' },
      eventTypeHeader: 'x-event',
      mappings: {
        pull_request: {
          action: '$.action',
          // missing number, title, sourceBranch, targetBranch, authorLogin
        },
      },
    };
    expect(() => CustomProviderMappingSchema.parse(bad)).toThrow();
  });

  it('rejects unknown verification kind', () => {
    const bad = {
      name: 'test',
      version: 1,
      verification: { kind: 'basic', header: 'x-tok' },
      eventTypeHeader: 'x-event',
      mappings: {},
    };
    expect(() => CustomProviderMappingSchema.parse(bad)).toThrow();
  });
});

describe('extractField', () => {
  it('extracts a top-level field', () => {
    expect(extractField({ action: 'opened' }, 'action')).toBe('opened');
  });

  it('extracts nested fields', () => {
    const obj = { pull_request: { user: { login: 'alice' } } };
    expect(extractField(obj, 'pull_request.user.login')).toBe('alice');
  });

  it('handles $. prefix', () => {
    const obj = { a: { b: { c: 42 } } };
    expect(extractField(obj, '$.a.b.c')).toBe(42);
  });

  it('returns undefined for missing paths', () => {
    expect(extractField({ a: 1 }, 'b')).toBeUndefined();
    expect(extractField({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when traversing null', () => {
    expect(extractField({ a: null }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing undefined', () => {
    expect(extractField({ a: undefined }, 'a.b')).toBeUndefined();
  });

  it('returns undefined for non-object values mid-path', () => {
    expect(extractField({ a: 'hello' }, 'a.b')).toBeUndefined();
    expect(extractField({ a: 42 }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when obj is null', () => {
    expect(extractField(null, 'a')).toBeUndefined();
  });

  it('returns undefined when obj is a primitive', () => {
    expect(extractField(42, 'a')).toBeUndefined();
    expect(extractField('hello', 'length')).toBeUndefined();
  });

  it('extracts boolean values', () => {
    expect(extractField({ pr: { draft: true } }, '$.pr.draft')).toBe(true);
    expect(extractField({ pr: { merged: false } }, 'pr.merged')).toBe(false);
  });

  it('extracts null leaf values', () => {
    expect(extractField({ pr: { body: null } }, 'pr.body')).toBeNull();
  });
});
