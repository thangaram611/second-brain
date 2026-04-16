import type { Command } from 'commander';

export function registerTailCommand(program: Command): void {
  // --- brain tail ---
  program
    .command('tail')
    .description('Tail live sessions from a supported foreign AI CLI (Copilot, etc.)')
    .option('-t, --tool <tool>', 'copilot | all', 'copilot')
    .option('--include-sqlite', 'Also run the SQLite post-session poller (Copilot)')
    .option('--idle <minutes>', 'Idle window before emitting session-end', '15')
    .action(async (options: { tool: string; includeSqlite?: boolean; idle: string }) => {
      const { createCopilotTailer, createCopilotSqlitePoller } = await import('@second-brain/collectors');
      const handles: Array<{ close: () => void | Promise<void> }> = [];
      const idleMs = Math.max(1, parseInt(options.idle, 10)) * 60_000;

      if (options.tool === 'copilot' || options.tool === 'all') {
        const tailer = createCopilotTailer({ idleMs });
        handles.push(tailer);
        console.log('[tail] copilot live tailer started');
        if (options.includeSqlite) {
          const poller = createCopilotSqlitePoller();
          handles.push(poller);
          console.log('[tail] copilot sqlite poller started');
        }
      }
      const stop = async () => {
        for (const h of handles) await h.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });

  // --- brain poll ---
  program
    .command('poll')
    .description('Poll a foreign SQLite store for new sessions (Codex)')
    .option('-t, --tool <tool>', 'codex', 'codex')
    .option('--interval <seconds>', 'Poll interval in seconds', '30')
    .action(async (options: { tool: string; interval: string }) => {
      const { createCodexSqlitePoller } = await import('@second-brain/collectors');
      const handles: Array<{ close: () => void | Promise<void> }> = [];
      const intervalMs = Math.max(5, parseInt(options.interval, 10)) * 1000;
      if (options.tool === 'codex') {
        let skipped = 0;
        const poller = createCodexSqlitePoller({ intervalMs, onSkip: () => skipped++ });
        handles.push(poller);
        console.log('[poll] codex state poller started');
        setInterval(() => {
          if (skipped > 0) {
            console.log(`[poll] codex_threads_skipped_memory_disabled=${skipped}`);
          }
        }, 60_000).unref();
      }
      const stop = async () => {
        for (const h of handles) await h.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });

  // --- brain co-ingest-claude-mem ---
  program
    .command('co-ingest-claude-mem')
    .description('One-shot import of claude-mem observations as reference entities (opt-in)')
    .option('--db <path>', 'Override claude-mem DB path')
    .option('--force', 'Bypass ENABLE_CLAUDE_MEM_INGEST gate')
    .action(async (options: { db?: string; force?: boolean }) => {
      if (!options.force && process.env.ENABLE_CLAUDE_MEM_INGEST !== 'true') {
        console.error('Refusing to run: set ENABLE_CLAUDE_MEM_INGEST=true or pass --force');
        process.exit(1);
      }
      const { ingestClaudeMemOnce } = await import('@second-brain/collectors');
      const result = await ingestClaudeMemOnce({ dbPath: options.db });
      if (result.disabled) {
        console.log(`claude-mem ingest disabled: ${result.disabled}`);
        return;
      }
      console.log(`imported ${result.importedReferences} observations from tables: ${result.tablesSeen.join(', ')}`);
    });
}
