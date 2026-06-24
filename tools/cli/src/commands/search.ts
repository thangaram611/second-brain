import type { Command } from 'commander';
import { ENTITY_TYPES, isEntityType } from '@second-brain/types';
import { openBrain } from '../lib/config.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search the brain')
    .argument('<query>', 'Search query')
    .option('-t, --type <types...>', 'Filter by entity type')
    .option('-n, --namespace <namespace>', 'Filter by namespace')
    .option('-l, --limit <limit>', 'Max results', '20')
    .action(
      (
        query: string,
        options: { type?: string[]; namespace?: string; limit: string },
      ) => {
        if (options.type) {
          const invalid = options.type.filter((t) => !isEntityType(t));
          if (invalid.length > 0) {
            console.error(`Invalid entity type(s): ${invalid.join(', ')}`);
            console.error(`Valid types: ${ENTITY_TYPES.join(', ')}`);
            process.exit(1);
          }
        }

        const brain = openBrain();
        try {
          const results = brain.search.search({
            query,
            types: options.type?.filter(isEntityType),
            namespace: options.namespace,
            limit: parseInt(options.limit, 10),
          });

          if (results.length === 0) {
            console.log('No results found.');
            return;
          }

          console.log(`Found ${results.length} result(s):\n`);
          for (const result of results) {
            const e = result.entity;
            console.log(`  [${e.type}] ${e.name}  (score: ${result.score.toFixed(3)})`);
            console.log(`    id: ${e.id}`);
            if (e.observations.length > 0) {
              for (const obs of e.observations) {
                console.log(`    - ${obs}`);
              }
            }
            if (e.tags.length > 0) {
              console.log(`    tags: ${e.tags.join(', ')}`);
            }
            console.log();
          }
        } finally {
          brain.close();
        }
      },
    );
}
