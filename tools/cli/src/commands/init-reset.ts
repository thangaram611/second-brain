import type { Command } from 'commander';

export function registerInitResetCommands(program: Command): void {
  // --- brain reset ---
  program
    .command('reset')
    .description('Undo init: remove ~/.second-brain (with confirmation), optionally restore ~/.claude.json')
    .option('-y, --yes', 'Non-interactive: proceed without confirmation')
    .option('--wire-claude', 'Also restore ~/.claude.json from its most recent backup')
    .option('--dir <path>', 'Override brain directory (defaults to ~/.second-brain)')
    .action(async (options: { yes?: boolean; wireClaude?: boolean; dir?: string }) => {
      const { runReset } = await import('../reset.js');
      await runReset(options);
    });

  // --- brain init ---
  program
    .command('init')
    .description('Initialize a new brain (interactive wizard)')
    .option('-p, --project <name>', 'Default namespace')
    .option('--db <path>', 'Custom database path')
    .option('-y, --yes', 'Non-interactive: accept defaults (ollama, personal namespace)')
    .option('--wire-claude', 'Opt-in: patch ~/.claude.json with the MCP server entry')
    .action(async (options: { project?: string; db?: string; yes?: boolean; wireClaude?: boolean }) => {
      const { runInit } = await import('../init.js');
      await runInit(options);
    });
}
