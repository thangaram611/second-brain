import type { Command } from 'commander';
import { openBrain } from '../lib/config.js';

export function registerDecideCommand(program: Command): void {
  program
    .command('decide')
    .description('Record a decision')
    .argument('<decision>', 'The decision made')
    .option('-c, --context <context>', 'Context for the decision')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .action(
      (
        decision: string,
        options: { context?: string; namespace: string },
      ) => {
        const brain = openBrain();
        try {
          const observations = [decision];
          if (options.context) observations.push(`Context: ${options.context}`);

          const entity = brain.entities.create({
            type: 'decision',
            name: decision.slice(0, 100),
            namespace: options.namespace,
            observations,
            source: { type: 'manual' },
          });

          console.log(`Decision recorded: "${entity.name}" (${entity.id})`);
        } finally {
          brain.close();
        }
      },
    );
}
