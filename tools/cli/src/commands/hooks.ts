import type { Command } from 'commander';

export function registerHooksCommands(program: Command): void {
  // --- brain install-hooks ---
  program
    .command('install-hooks')
    .description('Install realtime hooks for supported AI CLIs (Claude Code, etc.)')
    .option('-s, --scope <scope>', 'user | project', 'user')
    .option('-t, --tool <tool>', 'claude | codex | copilot | gemini | all', 'claude')
    .option('--exclusive', 'Remove claude-mem hooks (backup kept) instead of coexisting')
    .option('--skip-if-claude-mem', 'Abort install when claude-mem is detected')
    .option('--hook-command <cmd>', 'Override the brain-hook binary name/path')
    .action(async (options: {
      scope?: 'user' | 'project';
      tool?: 'claude' | 'codex' | 'copilot' | 'gemini' | 'all';
      exclusive?: boolean;
      skipIfClaudeMem?: boolean;
      hookCommand?: string;
    }) => {
      const { installClaudeHooks } = await import('../install-claude-hooks.js');
      const tool = options.tool ?? 'claude';
      if (tool !== 'claude' && tool !== 'all') {
        console.error(`Tool "${tool}" has no hook mechanism; use 'brain tail --tool ${tool}' instead.`);
        process.exit(1);
      }
      const result = installClaudeHooks({
        scope: options.scope ?? 'user',
        tool: 'claude',
        exclusive: options.exclusive,
        skipIfClaudeMem: options.skipIfClaudeMem,
        hookCommand: options.hookCommand,
      });
      if (result.skipped) {
        console.log(`Skipped: ${result.skipped}`);
        return;
      }
      console.log(`Wrote ${result.settingsPath}`);
      console.log(`Hooks: ${result.addedHooks.length ? result.addedHooks.join(', ') : '(none — already present)'}`);
      if (result.coexistedWithClaudeMem) {
        console.log('Note: existing claude-mem hooks detected; coexisting (both will run).');
      }
      if (result.backupPath) {
        console.log(`claude-mem hooks backed up to ${result.backupPath}`);
      }
    });

  // --- brain uninstall-hooks ---
  program
    .command('uninstall-hooks')
    .description('Remove hooks installed by `brain install-hooks`')
    .option('-s, --scope <scope>', 'user | project', 'user')
    .action(async (options: { scope?: 'user' | 'project' }) => {
      const { uninstallClaudeHooks } = await import('../install-claude-hooks.js');
      const result = uninstallClaudeHooks({ scope: options.scope ?? 'user' });
      console.log(`Updated ${result.settingsPath}`);
      console.log(`Removed: ${result.removed.length ? result.removed.join(', ') : '(none)'}`);
    });
}
