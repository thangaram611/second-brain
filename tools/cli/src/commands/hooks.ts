/**
 * Legacy `brain install-hooks` / `uninstall-hooks` commands.
 *
 * As of PR3 these are deprecation aliases for `brain wire-assistant claude`
 * (and the matching `unwire-assistant`). They keep working for one minor
 * version so existing scripts don't break, but emit a warning on every run.
 */
import * as os from 'node:os';
import type { Command } from 'commander';
import { ADAPTERS } from '../adapters/index.js';

export function registerHooksCommands(program: Command): void {
  // --- brain install-hooks (deprecated) ---
  program
    .command('install-hooks')
    .description('[DEPRECATED] Use `brain wire-assistant claude` instead')
    .option('-s, --scope <scope>', 'user | project', 'user')
    .option('-t, --tool <tool>', 'claude | codex | copilot | gemini | all', 'claude')
    .option('--exclusive', 'Remove claude-mem hooks (backup kept) instead of coexisting')
    .option('--skip-if-claude-mem', 'Abort install when claude-mem is detected')
    .option('--hook-command <cmd>', 'Override the brain-hook binary name/path')
    .action((options: {
      scope?: 'user' | 'project';
      tool?: 'claude' | 'codex' | 'copilot' | 'gemini' | 'all';
      exclusive?: boolean;
      skipIfClaudeMem?: boolean;
      hookCommand?: string;
    }) => {
      console.warn('[deprecated] `brain install-hooks` is now `brain wire-assistant claude`. This alias will be removed in a future release.');
      const tool = options.tool ?? 'claude';
      if (tool !== 'claude' && tool !== 'all') {
        console.error(`Tool "${tool}" has no hook mechanism; use 'brain tail --tool ${tool}' instead.`);
        process.exit(1);
      }
      const result = ADAPTERS.claude.install({
        scope: options.scope ?? 'user',
        home: os.homedir(),
        cwd: process.cwd(),
        skipIfClaudeMem: options.skipIfClaudeMem,
        exclusive: options.exclusive,
        hookCommand: options.hookCommand,
      });
      if (result.skipped) {
        console.log(`Skipped: ${result.skipped}`);
        return;
      }
      console.log(`Wrote ${result.configPath}`);
      console.log(`Hooks: ${result.addedEvents.length ? result.addedEvents.join(', ') : '(none — already present)'}`);
      for (const w of result.warnings) console.log(`Note: ${w}`);
      if (result.backupPath) {
        console.log(`claude-mem hooks backed up to ${result.backupPath}`);
      }
    });

  // --- brain uninstall-hooks (deprecated) ---
  program
    .command('uninstall-hooks')
    .description('[DEPRECATED] Use `brain unwire-assistant claude` instead')
    .option('-s, --scope <scope>', 'user | project', 'user')
    .action((options: { scope?: 'user' | 'project' }) => {
      console.warn('[deprecated] `brain uninstall-hooks` is now `brain unwire-assistant claude`. This alias will be removed in a future release.');
      const result = ADAPTERS.claude.uninstall({
        scope: options.scope ?? 'user',
        home: os.homedir(),
        cwd: process.cwd(),
      });
      console.log(`Updated ${result.configPath}`);
      console.log(`Removed: ${result.removed.length ? result.removed.join(', ') : '(none)'}`);
    });
}
