import { describe, it, expect } from 'vitest';
import { canonicalizeEmail, AuthorSchema, BranchContextSchema, BranchStatusPatchSchema } from '@second-brain/types';

describe('canonicalizeEmail', () => {
  it('unwraps GitHub noreply aliases', () => {
    expect(canonicalizeEmail('1234567+login@users.noreply.github.com')).toBe(
      'login@users.noreply.github.com',
    );
  });

  it('leaves GitLab noreply as-is (already canonical)', () => {
    expect(canonicalizeEmail('login@users.noreply.gitlab.com')).toBe(
      'login@users.noreply.gitlab.com',
    );
  });

  it('lowercases and trims plain emails', () => {
    expect(canonicalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });
});

describe('AuthorSchema', () => {
  it('accepts a valid author', () => {
    const parsed = AuthorSchema.parse({
      canonicalEmail: 'alice@example.com',
      displayName: 'Alice',
      aliases: ['a@example.com'],
    });
    expect(parsed.canonicalEmail).toBe('alice@example.com');
  });

  it('defaults aliases to empty array', () => {
    const parsed = AuthorSchema.parse({ canonicalEmail: 'bob@example.com' });
    expect(parsed.aliases).toEqual([]);
  });

  it('rejects bad emails', () => {
    expect(() => AuthorSchema.parse({ canonicalEmail: 'not-an-email' })).toThrow();
  });
});

describe('BranchContextSchema', () => {
  it('validates a WIP branch context', () => {
    const parsed = BranchContextSchema.parse({
      branch: 'feature/x',
      status: 'wip',
    });
    expect(parsed.status).toBe('wip');
  });

  it('allows merged with timestamp + mrIid', () => {
    const parsed = BranchContextSchema.parse({
      branch: 'feature/y',
      status: 'merged',
      mergedAt: '2026-04-13T10:00:00.000Z',
      mrIid: 42,
    });
    expect(parsed.mrIid).toBe(42);
  });

  it('rejects unknown status', () => {
    expect(() => BranchContextSchema.parse({ branch: 'foo', status: 'pending' })).toThrow();
  });
});

describe('BranchStatusPatchSchema', () => {
  it('validates a flip-to-merged patch', () => {
    const parsed = BranchStatusPatchSchema.parse({
      status: 'merged',
      mergedAt: '2026-04-13T10:00:00.000Z',
      mrIid: 99,
    });
    expect(parsed.status).toBe('merged');
  });

  it('accepts null mrIid / mergedAt', () => {
    const parsed = BranchStatusPatchSchema.parse({
      status: 'abandoned',
      mrIid: null,
      mergedAt: null,
    });
    expect(parsed.status).toBe('abandoned');
  });
});
