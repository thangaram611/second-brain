/**
 * Shared idempotent merge of the `second-brain` MCP server entry into a
 * host `mcp*.json` file (Copilot `~/.copilot/mcp-config.json`, Cursor
 * `<repo>/.cursor/mcp.json`). Unrelated top-level keys and other servers are
 * preserved; the file is rewritten only when the desired entry differs.
 *
 * The caller passes the ALREADY-RESOLVED invocation — this helper never calls
 * `resolveBrainMcpInvocation` itself, so each adapter keeps its own resolve
 * call site (the test spy seam) intact.
 */

import * as fs from 'node:fs';
import { isRecord, writeJson } from './json-file.js';
import type { BrainMcpInvocation } from '../mcp-resolve.js';

/**
 * Merge the resolved `invocation` as `mcpServers['second-brain']` into the file
 * at `mcpPath`. Returns whether the file was written.
 */
export function upsertMcpServersJson(
  mcpPath: string,
  invocation: BrainMcpInvocation,
): { written: boolean } {
  let mcp: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf8');
      if (raw.trim()) {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          const servers = parsed.mcpServers;
          mcp = { mcpServers: isRecord(servers) ? { ...servers } : {} };
          // Preserve unrelated top-level keys.
          for (const [k, v] of Object.entries(parsed)) {
            if (k !== 'mcpServers') {
              const obj: Record<string, unknown> = mcp;
              obj[k] = v;
            }
          }
        }
      }
    } catch {
      // fall through to defaults
    }
  }
  const desired: Record<string, unknown> = {
    command: invocation.command,
    args: invocation.args,
  };
  if (invocation.env) desired.env = invocation.env;
  const existingEntry = mcp.mcpServers['second-brain'];
  if (JSON.stringify(existingEntry) === JSON.stringify(desired)) {
    return { written: false };
  }
  mcp.mcpServers['second-brain'] = desired;
  writeJson(mcpPath, mcp);
  return { written: true };
}
