#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

const dbPath = process.env.BRAIN_DB_PATH ?? DEFAULT_DB_PATH;

const { mcp, brain } = createMcpServer({ dbPath });

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
