import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Brain } from '@second-brain/core';
import { resolveLLMConfig, tryCreateEmbeddingGenerator } from '@second-brain/ingestion';
import { registerReadTools } from './tools/read-tools.js';
import { registerWriteTools } from './tools/write-tools.js';
import { registerPipelineTools } from './tools/pipeline-tools.js';
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

  // If embeddings already exist on disk, wire the vector search channel now so
  // query_graph uses it from the first call — not only after rebuild_embeddings
  // runs in this process. Best-effort: degrade to full-text if no embedder.
  try {
    if (brain.enableVectorSearchFromStore() !== null) {
      const generator = tryCreateEmbeddingGenerator(resolveLLMConfig(), {
        logger: { warn: (m) => console.warn('[second-brain] vector channel disabled:', m) },
      });
      if (generator) {
        brain.attachVectorChannel((q) => generator.generateQuery(q));
      }
    }
  } catch (err) {
    console.warn(
      '[second-brain] vector channel init skipped:',
      err instanceof Error ? err.message : err,
    );
  }

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
  registerPipelineTools(mcp, brain);
  registerResources(mcp, brain);

  return { mcp, brain };
}
