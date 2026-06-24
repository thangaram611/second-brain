import type { Command } from 'commander';
import {
  resolveLLMConfig,
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
} from '@second-brain/collectors';
import type { LLMConfig } from '@second-brain/collectors';
import { openBrain, cliLogger } from '../lib/config.js';

export function registerQueryCommand(program: Command): void {
  program
    .command('query <question...>')
    .description('Natural-language query (uses LLM if configured, falls back to FTS)')
    .option('-n, --namespace <namespace>', 'Filter by namespace')
    .option('--limit <n>', 'Max results', '10')
    .option('--vector', 'Run vector channel too (requires embeddings)', false)
    .action(async (questionTokens: string[], options: { namespace?: string; limit: string; vector: boolean }) => {
      const question = questionTokens.join(' ');
      const brain = openBrain();
      try {
        // Resolve config once; the keyword extractor and the vector channel are
        // both optional and degrade independently of each other.
        let cfg: LLMConfig | null = null;
        try {
          cfg = resolveLLMConfig();
        } catch {
          cfg = null;
        }

        // LLM keyword extraction (best-effort — the chat model may be unavailable).
        let queryText = question;
        let usedLlm = false;
        if (cfg) {
          try {
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
          } catch {
            // Chat model unavailable → search the raw question instead.
          }
        }

        // Vector channel — independent of keyword extraction. Size the vec table
        // to the stored embeddings (not a guessed default), and only attach when
        // embeddings actually exist.
        if (options.vector && cfg) {
          try {
            const store = brain.enableVectorSearchFromStore();
            if (store === null) {
              console.error('No embeddings stored yet — run `brain embed` first. Using full-text search.');
            } else if (!brain.search.hasVectorChannel()) {
              const generator = tryCreateEmbeddingGenerator(cfg, { logger: cliLogger });
              if (generator) {
                brain.attachVectorChannel((q) => generator.generateQuery(q));
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Vector search unavailable (${msg}); using full-text only.`);
          }
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
