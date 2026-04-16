import type { Command } from 'commander';
import { openBrain, getDbPath } from '../lib/config.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show brain statistics')
    .option('-n, --namespace <namespace>', 'Filter by namespace')
    .action((options: { namespace?: string }) => {
      const brain = openBrain();
      try {
        const stats = brain.search.getStats(options.namespace);
        const dbPath = getDbPath();

        console.log(`Brain: ${dbPath}`);
        console.log(`Entities: ${stats.totalEntities}`);
        console.log(`Relations: ${stats.totalRelations}`);
        console.log(`Namespaces: ${stats.namespaces.join(', ') || '(none)'}`);

        if (Object.keys(stats.entitiesByType).length > 0) {
          console.log('\nEntities by type:');
          for (const [type, count] of Object.entries(stats.entitiesByType)) {
            console.log(`  ${type}: ${count}`);
          }
        }

        if (Object.keys(stats.relationsByType).length > 0) {
          console.log('\nRelations by type:');
          for (const [type, count] of Object.entries(stats.relationsByType)) {
            console.log(`  ${type}: ${count}`);
          }
        }
      } finally {
        brain.close();
      }
    });
}
