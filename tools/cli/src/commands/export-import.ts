import type { Command } from 'commander';
import { exportJson, exportJsonLd, exportDot, importGraph } from '@second-brain/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openBrain } from '../lib/config.js';

export function registerExportImportCommands(program: Command): void {
  // --- brain export ---
  program
    .command('export')
    .description('Export the knowledge graph')
    .requiredOption('--format <format>', 'json | json-ld | dot')
    .option('-n, --namespace <namespace>', 'Filter by namespace')
    .option('-o, --output <file>', 'Write to file (default: stdout)')
    .action((options: { format: string; namespace?: string; output?: string }) => {
      const format = options.format;
      if (format !== 'json' && format !== 'json-ld' && format !== 'dot') {
        console.error(`Invalid format: ${format}. Use json | json-ld | dot.`);
        process.exit(1);
      }
      const brain = openBrain();
      try {
        const content =
          format === 'json'
            ? exportJson(brain, { format: 'json', namespace: options.namespace })
            : format === 'json-ld'
              ? exportJsonLd(brain, { format: 'json-ld', namespace: options.namespace })
              : exportDot(brain, { format: 'dot', namespace: options.namespace });
        if (options.output) {
          fs.writeFileSync(options.output, content, 'utf-8');
          console.log(`Wrote ${content.length} bytes to ${options.output}`);
        } else {
          process.stdout.write(content);
        }
      } finally {
        brain.close();
      }
    });

  // --- brain import ---
  program
    .command('import <file>')
    .description('Import entities + relations from a graph file')
    .option('--format <format>', 'json | json-ld (auto-detected from extension when omitted)')
    .option('--strategy <strategy>', 'replace | merge | upsert', 'upsert')
    .option('-n, --namespace <namespace>', 'Override namespace for imported items')
    .action((file: string, options: { format?: string; strategy: string; namespace?: string }) => {
      const filePath = path.resolve(file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const format = options.format ?? (filePath.endsWith('.jsonld') ? 'json-ld' : 'json');
      if (format !== 'json' && format !== 'json-ld') {
        console.error(`Invalid format: ${format}. Use json | json-ld.`);
        process.exit(1);
      }
      const strategy = options.strategy;
      if (strategy !== 'replace' && strategy !== 'merge' && strategy !== 'upsert') {
        console.error(`Invalid strategy: ${strategy}. Use replace | merge | upsert.`);
        process.exit(1);
      }
      const brain = openBrain();
      try {
        const result = importGraph(brain, content, {
          format,
          strategy,
          namespace: options.namespace,
        });
        console.log(`Imported ${result.entitiesImported} entities, ${result.relationsImported} relations.`);
        if (result.conflicts.length > 0) {
          console.log(`${result.conflicts.length} conflict(s):`);
          for (const c of result.conflicts.slice(0, 10)) {
            console.log(`  - ${c.entityType}/${c.entityName}: ${c.reason}`);
          }
        }
      } finally {
        brain.close();
      }
    });
}
