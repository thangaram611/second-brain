import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';

export const CodeownersRuleSchema = z.object({
  pattern: z.string(),
  owners: z.array(z.string()),
});
export type CodeownersRule = z.infer<typeof CodeownersRuleSchema>;

export interface CodeownersResult {
  rules: CodeownersRule[];
  match: (path: string) => string[];
}

/**
 * Parse CODEOWNERS file content into rules and a matcher.
 * Lines starting with # are comments. Blank lines are skipped.
 * Each rule line: `<pattern> <owner1> [owner2 ...]`
 * Last matching rule wins (GitHub convention).
 */
export function parseCodeowners(content: string): CodeownersResult {
  const rules: CodeownersRule[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const pattern = parts[0];
    const owners = parts.slice(1);
    rules.push({ pattern, owners });
  }

  return {
    rules,
    match(path: string): string[] {
      // Last matching rule wins — iterate in reverse, return first match.
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i];
        const globPattern = normalizePattern(rule.pattern);
        if (picomatch.isMatch(path, globPattern, { dot: true })) {
          return rule.owners;
        }
      }
      return [];
    },
  };
}

/**
 * Normalize a CODEOWNERS pattern to a picomatch-compatible glob.
 * - Patterns without `/` match anywhere in the tree (prepend `**​/`).
 * - Patterns ending with `/` match all files under that directory.
 * - Leading `/` means repo-root-relative (strip it).
 */
function normalizePattern(pattern: string): string {
  let p = pattern;

  // Strip leading slash (root-relative marker)
  if (p.startsWith('/')) {
    p = p.slice(1);
  }

  // Directory pattern → match everything inside
  if (p.endsWith('/')) {
    return p + '**';
  }

  // If pattern has no slash, it can match anywhere in the tree
  if (!p.includes('/')) {
    return '**/' + p;
  }

  return p;
}

const CODEOWNERS_PATHS = [
  '.github/CODEOWNERS',
  '.gitlab/CODEOWNERS',
  'CODEOWNERS',
];

/**
 * Attempt to load a CODEOWNERS file from well-known locations in a repo.
 * Returns null if no CODEOWNERS file is found.
 */
export function loadCodeowners(repoRoot: string): CodeownersResult | null {
  for (const rel of CODEOWNERS_PATHS) {
    try {
      const content = readFileSync(join(repoRoot, rel), 'utf-8');
      return parseCodeowners(content);
    } catch {
      // File not found — try next location
    }
  }
  return null;
}

/**
 * Placeholder for future handle-to-person resolution.
 * Will look up `person` entities in the brain by `properties.aliases`.
 */
export function resolveHandle(_handle: string): string | null {
  return null;
}
