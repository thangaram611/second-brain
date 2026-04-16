import type { Command } from 'commander';
import { Brain } from '@second-brain/core';
import {
  EmbedPipeline,
  resolveLLMConfig,
  tryCreateEmbeddingGenerator,
} from '@second-brain/collectors';
import { getDbPath, cliLogger } from '../lib/config.js';

export function registerEmbedCommand(program: Command): void {
  program
    .command('embed')
    .description('Generate vector embeddings for entities (requires LLM config)')
    .option('-n, --namespace <namespace>', 'Limit to namespace')
    .option('--batch-size <n>', 'Embeddings per request', '64')
    .option('--dimensions <n>', 'Embedding dimensions (e.g. 768 for nomic-embed-text)', '768')
    .action(async (options: { namespace?: string; batchSize: string; dimensions: string }) => {
      const dims = parseInt(options.dimensions, 10);
      const brain = new Brain({ path: getDbPath(), vectorDimensions: dims });
      try {
        const cfg = resolveLLMConfig();
        const generator = tryCreateEmbeddingGenerator(cfg, { logger: cliLogger });
        if (!generator) {
          console.error('Embeddings require a provider with an API key (or ollama running locally). Nothing to do.');
          process.exitCode = 1;
          return;
        }
        const pipeline = new EmbedPipeline(brain, generator, {
          namespace: options.namespace,
          batchSize: parseInt(options.batchSize, 10),
          onProgress: (p) => console.log(`embedded=${p.embedded} skipped=${p.skipped} errors=${p.errors}`),
        });
        const summary = await pipeline.run();
        console.log(`\nEmbedding complete: ${summary.embedded} embedded, ${summary.skipped} unchanged, ${summary.errors} errors (${summary.durationMs}ms)`);
      } finally {
        brain.close();
      }
    });
}
