#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

const dbPath = process.env.BRAIN_DB_PATH ?? DEFAULT_DB_PATH;

let mcp: ReturnType<typeof createMcpServer>['mcp'];
let brain: ReturnType<typeof createMcpServer>['brain'];
try {
  ({ mcp, brain } = createMcpServer({ dbPath }));
} catch (err) {
  // The MCP transport is not yet connected, so the host (Codex/Cursor/etc.)
  // sees only "connection closed". Print a one-line actionable hint to stderr
  // so the user can diagnose by running this binary manually or checking the
  // host's MCP log.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[second-brain mcp] startup failed: ${msg}\n`);
  process.exit(1);
}

const transport = new StdioServerTransport();

// Clean up on exit
process.on('SIGINT', () => {
  brain.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  brain.close();
  process.exit(0);
});

await mcp.connect(transport);
