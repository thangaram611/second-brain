import type { Command } from 'commander';
import { Brain, VectorSearchChannel } from '@second-brain/core';
import {
  resolveLLMConfig,
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
} from '@second-brain/collectors';
import { openBrain, getDbPath, cliLogger } from '../lib/config.js';

export function registerQueryCommand(program: Command): void {
  program
    .command('query <question...>')
    .description('Natural-language query (uses LLM if configured, falls back to FTS)')
    .option('-n, --namespace <namespace>', 'Filter by namespace')
    .option('--limit <n>', 'Max results', '10')
    .option('--vector', 'Run vector channel too (requires embeddings)', false)
    .action(async (questionTokens: string[], options: { namespace?: string; limit: string; vector: boolean }) => {
      const question = questionTokens.join(' ');
      const dims = parseInt(process.env.BRAIN_EMBEDDING_DIMS ?? '768', 10);
      const brain = options.vector
        ? new Brain({ path: getDbPath(), vectorDimensions: dims })
        : openBrain();
      try {
        let queryText = question;
        let usedLlm = false;
        try {
          const cfg = resolveLLMConfig();
          const extractor = tryCreateLLMExtractor(cfg, {
            logger: cliLogger,
            systemPrompt: 'Extract 1-3 short search keywords from this question as entity names.',
            maxInputChars: 1000,
          });
          if (extractor) {
            const probe = await extractor.extract(question, {
              namespace: options.namespace,
              source: { type: 'manual' },
            });
            if (probe.entities.length > 0) {
              queryText = probe.entities.map((e) => e.name).join(' ');
              usedLlm = true;
            }
          }
          if (options.vector && brain.embeddings !== null && !brain.search.hasVectorChannel()) {
            const generator = tryCreateEmbeddingGenerator(cfg, { logger: cliLogger });
            if (generator) {
              brain.search.setVectorChannel(
                new VectorSearchChannel(brain.embeddings, brain.entities, (q) =>
                  generator.generateOne(q),
                ),
              );
            }
          }
        } catch {
          // No LLM → plain FTS.
        }

        const results = await brain.search.searchMulti({
          query: queryText,
          namespace: options.namespace,
          limit: parseInt(options.limit, 10),
        });
        if (results.length === 0) {
          console.log(`No matches for "${question}"${usedLlm ? ` (interpreted as: ${queryText})` : ''}.`);
          return;
        }
        console.log(`Top ${results.length} matches${usedLlm ? ` (interpreted as: ${queryText})` : ''}:`);
        for (const r of results) {
          console.log(`  [${r.entity.type}] ${r.entity.name} — ${r.matchChannel} (${r.score.toFixed(3)})`);
          console.log(`    ${r.entity.id}`);
        }
      } finally {
        brain.close();
      }
    });
}
