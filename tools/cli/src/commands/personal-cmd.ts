import type { Command } from 'commander';
import { openBrain } from '../lib/config.js';

export function registerPersonalCommand(program: Command): void {
  const personal = program
    .command('personal')
    .description('Manage personal personality data');

  personal
    .command('export')
    .description('Export personal namespace data')
    .requiredOption('-o, --out <file>', 'Output file path')
    .option('--encrypt', 'Encrypt with passphrase')
    .option('--json', 'Output as JSON')
    .action(async (options: { out: string; encrypt?: boolean; json?: boolean }) => {
      const { runPersonalExport } = await import('../personal.js');
      const brain = openBrain();
      try {
        await runPersonalExport(brain, options);
      } finally {
        brain.close();
      }
    });

  personal
    .command('import')
    .description('Import personal namespace data')
    .argument('<file>', 'Bundle file to import')
    .option('--reattach', 'Reattach dangling cross-namespace edges if targets exist locally')
    .option('--json', 'Output as JSON')
    .action(async (file: string, options: { reattach?: boolean; json?: boolean }) => {
      const { runPersonalImport } = await import('../personal.js');
      const brain = openBrain();
      try {
        await runPersonalImport(brain, { file, ...options });
      } finally {
        brain.close();
      }
    });

  personal
    .command('stats')
    .description('Show personal namespace statistics')
    .option('--audit', 'Show detailed provenance for each personality entity')
    .option('--json', 'Output as JSON')
    .action(async (options: { audit?: boolean; json?: boolean }) => {
      const { runPersonalStats } = await import('../personal.js');
      const brain = openBrain();
      try {
        await runPersonalStats(brain, options);
      } finally {
        brain.close();
      }
    });
}
