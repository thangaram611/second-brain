import type { Command } from 'commander';
import * as path from 'node:path';
import {
  PipelineRunner,
  GitCollector,
  ASTCollector,
  DocCollector,
  ConversationCollector,
  GitHubCollector,
  resolveLLMConfig,
  tryCreateLLMExtractor,
} from '@second-brain/collectors';
import type { PipelineProgress } from '@second-brain/collectors';
import { openBrain, cliLogger } from '../lib/config.js';

export function registerIndexCommand(program: Command): void {
  const indexCmd = program
    .command('index')
    .description('Index development activity into the brain')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--repo <path>', 'Repository path', '.')
    .action(
      async (options: { namespace: string; repo: string }) => {
        const brain = openBrain();
        try {
          const repoPath = path.resolve(options.repo);
          const runner = new PipelineRunner(brain);
          runner.register(new GitCollector({ maxCommits: 50 }));
          runner.register(new ASTCollector());

          const summary = await runner.run({
            namespace: options.namespace,
            repoPath,
            ignorePatterns: ['node_modules', 'dist', '.git', '.turbo', 'coverage'],
            onProgress: (p: PipelineProgress) => {
              console.log(`[${p.stage}] ${p.message}`);
            },
          });

          console.log(`\nIndexing complete:`);
          console.log(`  Entities: ${summary.entitiesCreated}`);
          console.log(`  Relations: ${summary.relationsCreated}`);
          if (summary.relationsSkipped > 0) {
            console.log(`  Relations skipped: ${summary.relationsSkipped}`);
          }
          if (summary.errors.length > 0) {
            console.log(`  Errors:`);
            for (const err of summary.errors) {
              console.log(`    [${err.collector}] ${err.message}`);
            }
          }
          console.log(`  Duration: ${summary.durationMs}ms`);
        } finally {
          brain.close();
        }
      },
    );

  // --- brain index git ---
  indexCmd
    .command('git')
    .description('Index git history')
    .option('--commits <count>', 'Number of recent commits', '50')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--repo <path>', 'Repository path', '.')
    .action(
      async (options: { commits: string; namespace: string; repo: string }) => {
        const brain = openBrain();
        try {
          const repoPath = path.resolve(options.repo);
          const runner = new PipelineRunner(brain);
          runner.register(new GitCollector({ maxCommits: parseInt(options.commits, 10) }));

          const summary = await runner.run({
            namespace: options.namespace,
            repoPath,
            ignorePatterns: ['node_modules', 'dist', '.git', '.turbo'],
            onProgress: (p: PipelineProgress) => {
              console.log(`[${p.stage}] ${p.message}`);
            },
          });

          console.log(`\nGit indexing complete: ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`);
        } finally {
          brain.close();
        }
      },
    );

  // --- brain index ast ---
  indexCmd
    .command('ast')
    .description('Index code AST (symbols, dependencies)')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--repo <path>', 'Repository path', '.')
    .action(
      async (options: { namespace: string; repo: string }) => {
        const brain = openBrain();
        try {
          const repoPath = path.resolve(options.repo);
          const runner = new PipelineRunner(brain);
          runner.register(new ASTCollector());

          const summary = await runner.run({
            namespace: options.namespace,
            repoPath,
            ignorePatterns: ['node_modules', 'dist', '.git', '.turbo', 'coverage'],
            onProgress: (p: PipelineProgress) => {
              console.log(`[${p.stage}] ${p.message}`);
            },
          });

          console.log(`\nAST indexing complete: ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`);
        } finally {
          brain.close();
        }
      },
    );

  // --- brain index docs ---
  indexCmd
    .command('docs')
    .description('Index markdown documentation (headings → concepts, links → references)')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--repo <path>', 'Root directory', '.')
    .option('--path <paths...>', 'Subdirectories to scan (relative to --repo)', ['.'])
    .option('--enrich', 'Use LLM to extract decisions/facts/patterns from prose', false)
    .action(async (options: { namespace: string; repo: string; path: string[]; enrich: boolean }) => {
      const brain = openBrain();
      try {
        const repoPath = path.resolve(options.repo);
        const runner = new PipelineRunner(brain);
        let collector: DocCollector;
        if (options.enrich) {
          const extractor = tryCreateLLMExtractor(resolveLLMConfig(), { logger: cliLogger });
          collector = extractor
            ? new DocCollector({ watchPaths: options.path, llmEnrich: true, extractor })
            : new DocCollector({ watchPaths: options.path });
        } else {
          collector = new DocCollector({ watchPaths: options.path });
        }
        runner.register(collector);

        const summary = await runner.run({
          namespace: options.namespace,
          repoPath,
          ignorePatterns: ['node_modules', 'dist', '.git', '.turbo'],
          onProgress: (p: PipelineProgress) => console.log(`[${p.stage}] ${p.message}`),
        });
        console.log(`\nDocs indexing complete: ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`);
      } finally {
        brain.close();
      }
    });

  // --- brain index conversation ---
  indexCmd
    .command('conversation')
    .description('Index AI conversation logs (Claude Code or generic JSONL)')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--source <path>', 'Conversations directory (default: ~/.claude/projects/)')
    .option('--file <path>', 'Specific conversation file')
    .option('--max <count>', 'Max conversations to process', '20')
    .action(async (options: { namespace: string; source?: string; file?: string; max: string }) => {
      const brain = openBrain();
      try {
        const convExtractor = tryCreateLLMExtractor(resolveLLMConfig(), { logger: cliLogger });
        if (!convExtractor) {
          console.error('Conversation indexing requires a working LLM. Configure one with `brain init` and re-run.');
          process.exitCode = 1;
          return;
        }
        const runner = new PipelineRunner(brain);
        runner.register(
          new ConversationCollector({
            source: options.source,
            file: options.file,
            extractor: convExtractor,
            maxConversations: parseInt(options.max, 10),
          }),
        );
        const summary = await runner.run({
          namespace: options.namespace,
          ignorePatterns: [],
          onProgress: (p: PipelineProgress) => console.log(`[${p.stage}] ${p.message}`),
        });
        console.log(`\nConversation indexing complete: ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`);
      } finally {
        brain.close();
      }
    });

  // --- brain index github ---
  indexCmd
    .command('github')
    .description('Index GitHub PRs/issues/reviews for a repository')
    .requiredOption('--repo <owner/name>', 'GitHub repository in owner/name format')
    .option('-n, --namespace <namespace>', 'Namespace', 'personal')
    .option('--token <token>', 'GitHub PAT (or set GITHUB_TOKEN)')
    .option('--max-prs <n>', 'Max PRs to fetch', '50')
    .option('--max-issues <n>', 'Max issues to fetch', '50')
    .option('--state <state>', 'PR/issue state filter (open|closed|all)', 'all')
    .option('--enrich', 'Use LLM to extract decisions from PR descriptions', false)
    .action(async (options: { namespace: string; repo: string; token?: string; maxPrs: string; maxIssues: string; state: string; enrich: boolean }) => {
      const brain = openBrain();
      try {
        const runner = new PipelineRunner(brain);
        const stateOpt = options.state === 'open' || options.state === 'closed' || options.state === 'all'
          ? options.state
          : 'all';
        const ghExtractor = options.enrich
          ? tryCreateLLMExtractor(resolveLLMConfig(), { logger: cliLogger })
          : undefined;
        runner.register(
          new GitHubCollector({
            repo: options.repo,
            token: options.token,
            maxPRs: parseInt(options.maxPrs, 10),
            maxIssues: parseInt(options.maxIssues, 10),
            state: stateOpt,
            ...(ghExtractor ? { extractor: ghExtractor } : {}),
          }),
        );
        const summary = await runner.run({
          namespace: options.namespace,
          ignorePatterns: [],
          onProgress: (p: PipelineProgress) => console.log(`[${p.stage}] ${p.message}`),
        });
        console.log(`\nGitHub indexing complete: ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`);
      } finally {
        brain.close();
      }
    });
}
