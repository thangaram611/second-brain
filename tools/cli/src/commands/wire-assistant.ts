/**
 * `brain wire-assistant <claude|cursor|codex|copilot|all>` and the matching
 * `unwire-assistant`. Walks the per-adapter registry; per-adapter failures
 * degrade to warnings (never abort).
 */

import * as os from 'node:os';
import type { Command } from 'commander';
import {
  ADAPTERS,
  ALL_ADAPTER_NAMES,
  type AdapterName,
} from '../adapters/index.js';

function isAdapterName(value: string): value is AdapterName {
  return value === 'claude' || value === 'cursor' || value === 'codex' || value === 'copilot';
}

function resolveTargets(arg: string): AdapterName[] {
  if (arg === 'all') return ALL_ADAPTER_NAMES;
  if (isAdapterName(arg)) return [arg];
  return [];
}

interface WireAssistantOptions {
  scope?: 'user' | 'project';
  hookCommand?: string;
  dryRun?: boolean;
}

export function registerWireAssistantCommands(program: Command): void {
  program
    .command('wire-assistant <name>')
    .description('Install Second Brain hooks for an AI assistant (claude|cursor|codex|copilot|all)')
    .option('-s, --scope <scope>', 'user | project', 'user')
    .option('--hook-command <cmd>', 'Override the brain-hook binary name/path')
    .option('--dry-run', 'Print what would be installed without writing files')
    .action((name: string, options: WireAssistantOptions) => {
      const targets = resolveTargets(name);
      if (targets.length === 0) {
        console.error(`Unknown assistant: ${name}. Use one of: claude | cursor | codex | copilot | all`);
        process.exit(1);
      }
      const home = os.homedir();
      const cwd = process.cwd();
      const scope = options.scope ?? 'user';

      for (const target of targets) {
        const adapter = ADAPTERS[target];
        if (options.dryRun) {
          console.log(`[dry-run] would install ${target} (scope=${scope})`);
          continue;
        }
        try {
          const result = adapter.install({
            scope,
            home,
            cwd,
            hookCommand: options.hookCommand,
          });
          if (result.skipped) {
            console.log(`${target}: skipped — ${result.skipped}`);
          } else {
            console.log(`${target}: wrote ${result.configPath}`);
            if (result.addedEvents.length > 0) {
              console.log(`  events: ${result.addedEvents.join(', ')}`);
            } else {
              console.log(`  events: (none — already up to date)`);
            }
            if (result.auxFiles.length > 0) {
              console.log(`  aux: ${result.auxFiles.join(', ')}`);
            }
          }
          for (const w of result.warnings) console.log(`  warn: ${w}`);
        } catch (err) {
          // Per plan §D — per-adapter failures must NEVER abort the run.
          console.warn(`${target}: install failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

  program
    .command('unwire-assistant <name>')
    .description('Remove Second Brain hooks for an AI assistant (claude|cursor|codex|copilot|all)')
    .option('-s, --scope <scope>', 'user | project', 'user')
    .action((name: string, options: WireAssistantOptions) => {
      const targets = resolveTargets(name);
      if (targets.length === 0) {
        console.error(`Unknown assistant: ${name}. Use one of: claude | cursor | codex | copilot | all`);
        process.exit(1);
      }
      const home = os.homedir();
      const cwd = process.cwd();
      const scope = options.scope ?? 'user';

      for (const target of targets) {
        const adapter = ADAPTERS[target];
        try {
          const result = adapter.uninstall({ scope, home, cwd });
          console.log(`${target}: updated ${result.configPath}`);
          if (result.removed.length > 0) {
            console.log(`  removed: ${result.removed.join(', ')}`);
          } else {
            console.log(`  removed: (none)`);
          }
        } catch (err) {
          console.warn(`${target}: uninstall failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
}
