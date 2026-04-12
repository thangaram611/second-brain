#!/usr/bin/env node

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

const dbPath = process.env.BRAIN_DB_PATH ?? DEFAULT_DB_PATH;
const port = parseInt(process.env.BRAIN_MCP_PORT ?? '7420', 10);
const authToken = process.env.BRAIN_AUTH_TOKEN;

const { mcp, brain } = createMcpServer({ dbPath });

const app = express();

// Bearer token auth middleware (when BRAIN_AUTH_TOKEN is set)
if (authToken) {
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${authToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
}

// Streamable HTTP transport at /mcp
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});

await mcp.connect(transport);

app.all('/mcp', async (req, res) => {
  await transport.handleRequest(req, res);
});

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

const server = app.listen(port, () => {
  console.error(`Second Brain MCP HTTP server listening on port ${port}`);
  console.error(`  MCP endpoint: http://localhost:${port}/mcp`);
  console.error(`  Health check: http://localhost:${port}/health`);
  if (authToken) {
    console.error(`  Auth: Bearer token required`);
  } else {
    console.error(`  Auth: disabled (set BRAIN_AUTH_TOKEN to enable)`);
  }
});

// Clean up on exit
function cleanup() {
  server.close();
  brain.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
