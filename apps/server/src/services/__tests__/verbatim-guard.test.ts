import { describe, it, expect } from 'vitest';
import { containsVerbatim } from '../personality/verbatim-guard.js';

describe('containsVerbatim', () => {
  const source =
    'The quick brown fox jumps over the lazy dog and then runs around the field';

  it('returns false when output does not match sources', () => {
    expect(containsVerbatim('Something completely different here today', [source])).toBe(false);
  });

  it('returns true when output contains 8+ word verbatim match', () => {
    const output = 'I once saw the quick brown fox jumps over the lazy dog in a park';
    expect(containsVerbatim(output, [source])).toBe(true);
  });

  it('returns false for short sources (< minNgram words)', () => {
    expect(containsVerbatim('hello world foo bar', ['hello world foo bar'])).toBe(false);
  });

  it('matches case-insensitively', () => {
    const output = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY dog and then';
    expect(containsVerbatim(output, [source])).toBe(true);
  });

  it('strips punctuation before matching', () => {
    const punctuatedSource =
      'The quick, brown fox jumps over the lazy dog and then runs around the field.';
    const output = 'the quick brown fox jumps over the lazy dog and then';
    expect(containsVerbatim(output, [punctuatedSource])).toBe(true);
  });

  it('supports custom minNgram value', () => {
    const output = 'the quick brown fox jumps';
    // 5-gram match with minNgram=5 should detect it
    expect(containsVerbatim(output, [source], 5)).toBe(true);
    // 10-gram match with minNgram=10 should not detect 5-word overlap
    expect(containsVerbatim(output, [source], 10)).toBe(false);
  });

  it('returns false for empty output', () => {
    expect(containsVerbatim('', [source])).toBe(false);
  });

  it('returns false for empty sources array', () => {
    expect(containsVerbatim('some text here', [])).toBe(false);
  });
});
