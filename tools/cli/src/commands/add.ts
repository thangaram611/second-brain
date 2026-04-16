import type { Command } from 'commander';
import type { EntityType, CreateEntityInput } from '@second-brain/types';
import { ENTITY_TYPES } from '@second-brain/types';
import { openBrain } from '../lib/config.js';

export function registerAddCommand(program: Command): void {
  program
    .command('add')
    .description('Add an entity to the brain')
    .argument('<type>', `Entity type (${ENTITY_TYPES.join(', ')})`)
    .argument('<name>', 'Entity name')
    .option('-o, --obs <observations...>', 'Observations (atomic facts)')
    .option('-t, --tags <tags...>', 'Tags')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .action(
      (
        type: string,
        name: string,
        options: { obs?: string[]; tags?: string[]; namespace: string },
      ) => {
        if (!ENTITY_TYPES.includes(type as EntityType)) {
          console.error(`Invalid entity type: ${type}`);
          console.error(`Valid types: ${ENTITY_TYPES.join(', ')}`);
          process.exit(1);
        }

        const brain = openBrain();
        try {
          const input: CreateEntityInput = {
            type: type as EntityType,
            name,
            namespace: options.namespace,
            observations: options.obs ?? [],
            tags: options.tags ?? [],
            source: { type: 'manual' },
          };

          const entity = brain.entities.create(input);
          console.log(`Created ${entity.type}: "${entity.name}" (${entity.id})`);
          if (entity.observations.length > 0) {
            for (const obs of entity.observations) {
              console.log(`  - ${obs}`);
            }
          }
        } finally {
          brain.close();
        }
      },
    );
}
