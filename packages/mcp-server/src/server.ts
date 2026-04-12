import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Brain } from '@second-brain/core';
import { registerReadTools } from './tools/read-tools.js';
import { registerWriteTools } from './tools/write-tools.js';
import { registerResources } from './resources/brain-resources.js';

export interface SecondBrainMcpOptions {
  dbPath: string;
  wal?: boolean;
}

export function createMcpServer(options: SecondBrainMcpOptions): {
  mcp: McpServer;
  brain: Brain;
} {
  const brain = new Brain({ path: options.dbPath, wal: options.wal });

  const mcp = new McpServer(
    {
      name: 'second-brain',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  registerReadTools(mcp, brain);
  registerWriteTools(mcp, brain);
  registerResources(mcp, brain);

  return { mcp, brain };
}
