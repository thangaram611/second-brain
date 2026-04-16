import { describe, it, expect } from 'vitest';
import { parseCodeowners, loadCodeowners, resolveHandle } from '../codeowners.js';

describe('parseCodeowners', () => {
  it('returns empty rules for an empty file', () => {
    const result = parseCodeowners('');
    expect(result.rules).toEqual([]);
    expect(result.match('anything.ts')).toEqual([]);
  });

  it('skips comment lines and blank lines', () => {
    const content = `
# This is a comment

# Another comment
*.ts @alice
    `;
    const result = parseCodeowners(content);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].pattern).toBe('*.ts');
    expect(result.rules[0].owners).toEqual(['@alice']);
  });

  it('parses multiple owners', () => {
    const content = 'packages/core/** @alice @bob @team/core';
    const result = parseCodeowners(content);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].owners).toEqual(['@alice', '@bob', '@team/core']);
  });

  it('parses multiple rules', () => {
    const content = [
      '*.ts @typescript-team',
      'docs/ @docs-team',
      '/apps/server/** @backend-team @alice',
    ].join('\n');
    const result = parseCodeowners(content);
    expect(result.rules).toHaveLength(3);
  });

  it('skips lines with only a pattern and no owners', () => {
    const content = '*.ts\n*.js @bob';
    const result = parseCodeowners(content);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].pattern).toBe('*.js');
  });
});

describe('CODEOWNERS matching', () => {
  it('matches exact file extension glob', () => {
    const result = parseCodeowners('*.ts @alice');
    expect(result.match('foo.ts')).toEqual(['@alice']);
    expect(result.match('src/deep/bar.ts')).toEqual(['@alice']);
    expect(result.match('foo.js')).toEqual([]);
  });

  it('matches directory glob patterns', () => {
    const result = parseCodeowners('packages/core/** @core-team');
    expect(result.match('packages/core/src/brain.ts')).toEqual(['@core-team']);
    expect(result.match('packages/core/README.md')).toEqual(['@core-team']);
    expect(result.match('packages/sync/src/index.ts')).toEqual([]);
  });

  it('matches directory patterns with trailing slash', () => {
    const result = parseCodeowners('docs/ @docs-team');
    expect(result.match('docs/guide.md')).toEqual(['@docs-team']);
    expect(result.match('docs/api/ref.md')).toEqual(['@docs-team']);
    expect(result.match('src/docs.ts')).toEqual([]);
  });

  it('last matching rule wins', () => {
    const content = [
      '* @default-team',
      'packages/core/** @core-team',
      'packages/core/src/brain.ts @alice',
    ].join('\n');
    const result = parseCodeowners(content);

    // Specific file match → last rule wins
    expect(result.match('packages/core/src/brain.ts')).toEqual(['@alice']);
    // Directory match → second rule wins
    expect(result.match('packages/core/src/search.ts')).toEqual(['@core-team']);
    // Fallback to wildcard
    expect(result.match('README.md')).toEqual(['@default-team']);
  });

  it('handles root-relative patterns (leading /)', () => {
    const content = '/apps/server/** @backend';
    const result = parseCodeowners(content);
    expect(result.match('apps/server/src/index.ts')).toEqual(['@backend']);
  });

  it('patterns without slash match anywhere in tree', () => {
    const content = 'Makefile @devops';
    const result = parseCodeowners(content);
    expect(result.match('Makefile')).toEqual(['@devops']);
    expect(result.match('sub/dir/Makefile')).toEqual(['@devops']);
  });
});

describe('loadCodeowners', () => {
  it('returns null when no CODEOWNERS file exists', () => {
    const result = loadCodeowners('/nonexistent/path/that/does/not/exist');
    expect(result).toBeNull();
  });
});

describe('resolveHandle', () => {
  it('returns null (placeholder for future implementation)', () => {
    expect(resolveHandle('@alice')).toBeNull();
  });
});
