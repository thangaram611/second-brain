/**
 * Catches a release-time silent break: if a future `tsdown` config change
 * starts inlining `import.meta.resolve(...)` to a literal string (or strips
 * it altogether), the adapters' MCP-resolve path would silently regress.
 *
 * The test reads the bundled output (built by `pnpm --filter @second-brain/cli
 * build`) and asserts that `import.meta.resolve` survives bundling intact.
 *
 * If the bundled output isn't present yet (fresh checkout pre-build), the
 * test is skipped — CI must build before running tests to exercise it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '..', '..', 'dist', 'index.mjs');

describe('bundled cli — import.meta.resolve survives tsdown', () => {
  it('dist/index.mjs (if built) preserves `import.meta.resolve` calls', () => {
    if (!fs.existsSync(distEntry)) {
      // Build hasn't run yet; smoke test deferred.
      // CI must invoke `pnpm -w build` before `pnpm test` to exercise this.
      return;
    }
    const bundle = fs.readFileSync(distEntry, 'utf8');
    expect(bundle).toContain('import.meta.resolve');
    // Defensive: bundled output must still reference our package specifier.
    expect(bundle).toContain('@second-brain/mcp-server/stdio');
  });
});
