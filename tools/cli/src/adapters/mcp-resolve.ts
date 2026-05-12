/**
 * Shared resolution of the `second-brain` MCP server invocation, used by every
 * adapter that writes an MCP entry into a host config (codex, cursor, copilot).
 *
 * Returns an absolute `command` (current node binary) + absolute path to
 * `packages/mcp-server/dist/stdio.mjs`. Works in both modes:
 *   - Monorepo dev: pnpm symlinks @second-brain/mcp-server into cli's node_modules
 *   - npm-installed: @second-brain/mcp-server is a transitive dep in the tarball
 *
 * On any resolution failure (subpath missing from exports, dep missing,
 * `dist/stdio.mjs` not built) returns { invocation: null, warning } so callers
 * can warn-and-skip the MCP block while still installing hooks.
 */

import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { z } from 'zod';

const InvocationSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});
export type BrainMcpInvocation = z.infer<typeof InvocationSchema>;

export interface ResolveResult {
  invocation: BrainMcpInvocation | null;
  warning?: string;
}

export interface ResolveOptions {
  brainDbPath?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveBrainMcpInvocation(opts: ResolveOptions = {}): ResolveResult {
  let stdioUrl: string;
  try {
    stdioUrl = import.meta.resolve('@second-brain/mcp-server/stdio');
  } catch (err) {
    return {
      invocation: null,
      warning:
        `Could not resolve @second-brain/mcp-server/stdio (${errMessage(err)}). ` +
        'MCP server entry skipped. Run `pnpm -w build` and re-run wire-assistant.',
    };
  }

  const stdioPath = fileURLToPath(stdioUrl);
  try {
    statSync(stdioPath);
  } catch {
    return {
      invocation: null,
      warning:
        `mcp-server build artifact missing at ${stdioPath}. ` +
        'Run `pnpm --filter @second-brain/mcp-server build` and re-run wire-assistant.',
    };
  }

  const envEntries = opts.brainDbPath ? { env: { BRAIN_DB_PATH: opts.brainDbPath } } : {};
  return {
    invocation: InvocationSchema.parse({
      command: process.execPath,
      args: [stdioPath],
      ...envEntries,
    }),
  };
}
