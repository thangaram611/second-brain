import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function shouldIgnore(relPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith('*')) {
      return relPath.endsWith(pattern.slice(1));
    }
    return relPath.includes(pattern);
  });
}

/**
 * Recursively find source files matching the given extensions,
 * excluding files that match ignore patterns.
 */
export async function scanFiles(
  rootDir: string,
  options?: {
    extensions?: Set<string>;
    ignorePatterns?: string[];
  },
): Promise<string[]> {
  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS;
  const ignorePatterns = options?.ignorePatterns ?? ['node_modules', 'dist', '.git'];
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, fullPath);

      if (shouldIgnore(relPath, ignorePatterns)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}
