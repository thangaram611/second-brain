#!/usr/bin/env node

import { Command } from 'commander';
import { Brain, exportJson, exportJsonLd, exportDot, importGraph, VectorSearchChannel, createLogger } from '@second-brain/core';
import type { BranchStatusPatch, EntityType, CreateEntityInput } from '@second-brain/types';
import { BRANCH_STATUSES, BranchStatusPatchSchema, ENTITY_TYPES } from '@second-brain/types';
import {
  PipelineRunner,
  GitCollector,
  ASTCollector,
  DocCollector,
  ConversationCollector,
  GitHubCollector,
  EmbedPipeline,
  resolveLLMConfig,
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
  createWatcher,
} from '@second-brain/collectors';
import type { PipelineProgress } from '@second-brain/collectors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

const cliLogger = createLogger('cli');

function getDbPath(): string {
  return process.env.BRAIN_DB_PATH ?? DEFAULT_DB_PATH;
}

function openBrain(): Brain {
  const dbPath = getDbPath();
  if (!fs.existsSync(path.dirname(dbPath))) {
    console.error(`Brain not initialized. Run: brain init`);
    process.exit(1);
  }
  return new Brain({ path: dbPath });
}

const program = new Command();

program
  .name('brain')
  .description('Second Brain — developer knowledge graph CLI')
  .version('0.1.0');

// --- brain reset ---
program
  .command('reset')
  .description('Undo init: remove ~/.second-brain (with confirmation), optionally restore ~/.claude.json')
  .option('-y, --yes', 'Non-interactive: proceed without confirmation')
  .option('--wire-claude', 'Also restore ~/.claude.json from its most recent backup')
  .option('--dir <path>', 'Override brain directory (defaults to ~/.second-brain)')
  .action(async (options: { yes?: boolean; wireClaude?: boolean; dir?: string }) => {
    const { runReset } = await import('./reset.js');
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
    const { runInit } = await import('./init.js');
    await runInit(options);
  });

// --- brain add ---
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

// --- brain search ---
program
  .command('search')
  .description('Search the brain')
  .argument('<query>', 'Search query')
  .option('-t, --type <types...>', 'Filter by entity type')
  .option('-n, --namespace <namespace>', 'Filter by namespace')
  .option('-l, --limit <limit>', 'Max results', '20')
  .action(
    (
      query: string,
      options: { type?: string[]; namespace?: string; limit: string },
    ) => {
      const brain = openBrain();
      try {
        const results = brain.search.search({
          query,
          types: options.type as EntityType[] | undefined,
          namespace: options.namespace,
          limit: parseInt(options.limit, 10),
        });

        if (results.length === 0) {
          console.log('No results found.');
          return;
        }

        console.log(`Found ${results.length} result(s):\n`);
        for (const result of results) {
          const e = result.entity;
          console.log(`  [${e.type}] ${e.name}  (score: ${result.score.toFixed(3)})`);
          console.log(`    id: ${e.id}`);
          if (e.observations.length > 0) {
            for (const obs of e.observations) {
              console.log(`    - ${obs}`);
            }
          }
          if (e.tags.length > 0) {
            console.log(`    tags: ${e.tags.join(', ')}`);
          }
          console.log();
        }
      } finally {
        brain.close();
      }
    },
  );

// --- brain status ---
program
  .command('status')
  .description('Show brain statistics')
  .option('-n, --namespace <namespace>', 'Filter by namespace')
  .action((options: { namespace?: string }) => {
    const brain = openBrain();
    try {
      const stats = brain.search.getStats(options.namespace);
      const dbPath = getDbPath();

      console.log(`Brain: ${dbPath}`);
      console.log(`Entities: ${stats.totalEntities}`);
      console.log(`Relations: ${stats.totalRelations}`);
      console.log(`Namespaces: ${stats.namespaces.join(', ') || '(none)'}`);

      if (Object.keys(stats.entitiesByType).length > 0) {
        console.log('\nEntities by type:');
        for (const [type, count] of Object.entries(stats.entitiesByType)) {
          console.log(`  ${type}: ${count}`);
        }
      }

      if (Object.keys(stats.relationsByType).length > 0) {
        console.log('\nRelations by type:');
        for (const [type, count] of Object.entries(stats.relationsByType)) {
          console.log(`  ${type}: ${count}`);
        }
      }
    } finally {
      brain.close();
    }
  });

// --- brain decide ---
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

// --- brain index ---
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

// --- brain watch ---
program
  .command('watch')
  .description('Watch a repository and re-index on change (AST + docs)')
  .option('-n, --namespace <namespace>', 'Namespace', 'personal')
  .option('--repo <path>', 'Repository path', '.')
  .option('--debounce <ms>', 'Debounce window for batched changes', '500')
  .action(async (options: { namespace: string; repo: string; debounce: string }) => {
    const repoPath = path.resolve(options.repo);
    const debounceMs = parseInt(options.debounce, 10);

    const runIndex = async (reason: string): Promise<void> => {
      const brain = openBrain();
      try {
        const runner = new PipelineRunner(brain);
        runner.register(new ASTCollector());
        runner.register(new DocCollector({ watchPaths: ['.'] }));
        const summary = await runner.run({
          namespace: options.namespace,
          repoPath,
          ignorePatterns: ['node_modules', 'dist', '.git', '.turbo', 'coverage'],
          onProgress: () => {},
        });
        console.log(
          `[${new Date().toISOString()}] ${reason} → ${summary.entitiesCreated} entities, ${summary.relationsCreated} relations (${summary.durationMs}ms)`,
        );
      } finally {
        brain.close();
      }
    };

    console.log(`Watching ${repoPath} (debounce ${debounceMs}ms). Ctrl-C to stop.`);
    await runIndex('initial index');

    const handle = createWatcher({
      roots: [repoPath],
      debounceMs,
      onBatch: async (batch) => {
        await runIndex(`re-index after ${batch.length} change(s)`);
      },
      onError: (err) => console.error('[watch]', err),
    });
    await handle.ready;

    const shutdown = async (): Promise<void> => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    // Keep process alive.
    await new Promise(() => {});
  });

// --- brain embed ---
program
  .command('embed')
  .description('Generate vector embeddings for entities (requires LLM config)')
  .option('-n, --namespace <namespace>', 'Limit to namespace')
  .option('--batch-size <n>', 'Embeddings per request', '64')
  .option('--dimensions <n>', 'Embedding dimensions (e.g. 768 for nomic-embed-text)', '768')
  .action(async (options: { namespace?: string; batchSize: string; dimensions: string }) => {
    const dims = parseInt(options.dimensions, 10);
    const brain = new Brain({ path: getDbPath(), vectorDimensions: dims });
    try {
      const cfg = resolveLLMConfig();
      const generator = tryCreateEmbeddingGenerator(cfg, { logger: cliLogger });
      if (!generator) {
        console.error('Embeddings require a provider with an API key (or ollama running locally). Nothing to do.');
        process.exitCode = 1;
        return;
      }
      const pipeline = new EmbedPipeline(brain, generator, {
        namespace: options.namespace,
        batchSize: parseInt(options.batchSize, 10),
        onProgress: (p) => console.log(`embedded=${p.embedded} skipped=${p.skipped} errors=${p.errors}`),
      });
      const summary = await pipeline.run();
      console.log(`\nEmbedding complete: ${summary.embedded} embedded, ${summary.skipped} unchanged, ${summary.errors} errors (${summary.durationMs}ms)`);
    } finally {
      brain.close();
    }
  });

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

// --- brain query ---
program
  .command('query <question...>')
  .description('Natural-language query (uses LLM if configured, falls back to FTS)')
  .option('-n, --namespace <namespace>', 'Filter by namespace')
  .option('--limit <n>', 'Max results', '10')
  .option('--vector', 'Run vector channel too (requires embeddings)', false)
  .action(async (questionTokens: string[], options: { namespace?: string; limit: string; vector: boolean }) => {
    const question = questionTokens.join(' ');
    const dims = parseInt(process.env.BRAIN_EMBEDDING_DIMS ?? '768', 10);
    const brain = options.vector
      ? new Brain({ path: getDbPath(), vectorDimensions: dims })
      : openBrain();
    try {
      let queryText = question;
      let usedLlm = false;
      try {
        const cfg = resolveLLMConfig();
        const extractor = tryCreateLLMExtractor(cfg, {
          logger: cliLogger,
          systemPrompt: 'Extract 1-3 short search keywords from this question as entity names.',
          maxInputChars: 1000,
        });
        if (extractor) {
          const probe = await extractor.extract(question, {
            namespace: options.namespace,
            source: { type: 'manual' },
          });
          if (probe.entities.length > 0) {
            queryText = probe.entities.map((e) => e.name).join(' ');
            usedLlm = true;
          }
        }
        if (options.vector && brain.embeddings !== null && !brain.search.hasVectorChannel()) {
          const generator = tryCreateEmbeddingGenerator(cfg, { logger: cliLogger });
          if (generator) {
            brain.search.setVectorChannel(
              new VectorSearchChannel(brain.embeddings, brain.entities, (q) =>
                generator.generateOne(q),
              ),
            );
          }
        }
      } catch {
        // No LLM → plain FTS.
      }

      const results = await brain.search.searchMulti({
        query: queryText,
        namespace: options.namespace,
        limit: parseInt(options.limit, 10),
      });
      if (results.length === 0) {
        console.log(`No matches for "${question}"${usedLlm ? ` (interpreted as: ${queryText})` : ''}.`);
        return;
      }
      console.log(`Top ${results.length} matches${usedLlm ? ` (interpreted as: ${queryText})` : ''}:`);
      for (const r of results) {
        console.log(`  [${r.entity.type}] ${r.entity.name} — ${r.matchChannel} (${r.score.toFixed(3)})`);
        console.log(`    ${r.entity.id}`);
      }
    } finally {
      brain.close();
    }
  });

// --- brain sync ---
const SERVER_URL = process.env.BRAIN_API_URL ?? 'http://localhost:7430';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string') {
    throw new Error(`Expected string for "${key}", got ${typeof val}`);
  }
  return val;
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number for "${key}", got ${typeof val}`);
  }
  return val;
}

function getStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') {
    throw new Error(`Expected string or null for "${key}", got ${typeof val}`);
  }
  return val;
}

interface SyncStatus {
  namespace: string;
  state: string;
  connectedPeers: number;
  lastSyncedAt: string | null;
  error: string | null;
}

function parseSyncStatus(raw: unknown): SyncStatus {
  if (!isRecord(raw)) {
    throw new Error('Expected object for sync status');
  }
  return {
    namespace: getString(raw, 'namespace'),
    state: getString(raw, 'state'),
    connectedPeers: getNumber(raw, 'connectedPeers'),
    lastSyncedAt: getStringOrNull(raw, 'lastSyncedAt'),
    error: getStringOrNull(raw, 'error'),
  };
}

const syncCmd = program
  .command('sync')
  .description('Team sync management');

// brain sync join --namespace <ns> --relay <url> [--secret <secret>]
syncCmd
  .command('join')
  .description('Join a sync room for a project namespace')
  .requiredOption('--namespace <namespace>', 'Project namespace to sync')
  .requiredOption('--relay <url>', 'Relay server WebSocket URL')
  .option('--secret <secret>', 'Shared secret for relay auth (or set RELAY_AUTH_SECRET)')
  .action(async (options: { namespace: string; relay: string; secret?: string }) => {
    const secret = options.secret ?? process.env.RELAY_AUTH_SECRET;
    if (!secret) {
      console.error('Error: --secret or RELAY_AUTH_SECRET required');
      process.exit(1);
    }

    if (options.namespace === 'personal') {
      console.error('Error: Cannot sync the personal namespace');
      process.exit(1);
    }

    try {
      // Step 1: Get auth token from relay
      const relayHttpUrl = options.relay.replace(/^ws/, 'http');
      const tokenRes = await fetch(`${relayHttpUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: options.namespace,
          userName: os.userInfo().username,
          secret,
        }),
      });

      if (!tokenRes.ok) {
        const err: unknown = await tokenRes.json().catch(() => ({ error: 'Auth failed' }));
        const message = isRecord(err) && typeof err.error === 'string'
          ? err.error
          : tokenRes.statusText;
        console.error(`Failed to authenticate with relay: ${message}`);
        process.exit(1);
      }

      const tokenBody: unknown = await tokenRes.json();
      if (!isRecord(tokenBody) || typeof tokenBody.token !== 'string') {
        console.error('Invalid token response from relay');
        process.exit(1);
      }
      const { token } = tokenBody;

      // Step 2: Tell the server to join sync
      const joinRes = await fetch(`${SERVER_URL}/api/sync/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: options.namespace,
          relayUrl: options.relay,
          token,
        }),
      });

      if (!joinRes.ok) {
        const err: unknown = await joinRes.json().catch(() => ({ error: 'Join failed' }));
        const message = isRecord(err) && typeof err.error === 'string'
          ? err.error
          : joinRes.statusText;
        console.error(`Failed to join sync: ${message}`);
        process.exit(1);
      }

      const status = parseSyncStatus(await joinRes.json());
      console.log(`Joined sync for namespace "${options.namespace}"`);
      console.log(`  State: ${status.state}`);
      console.log(`  Relay: ${options.relay}`);
      console.log(`  Peers: ${status.connectedPeers}`);
    } catch (err) {
      if (err instanceof Error) {
        console.error(`Error: ${err.message}`);
      }
      process.exit(1);
    }
  });

// brain sync status
syncCmd
  .command('status')
  .description('Show sync status for all synced namespaces')
  .action(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/sync/status`);
      if (!res.ok) {
        console.error('Failed to fetch sync status. Is the server running?');
        process.exit(1);
      }

      const raw: unknown = await res.json();
      if (!Array.isArray(raw)) {
        console.error('Invalid sync status response');
        process.exit(1);
      }
      const statuses = raw.map(parseSyncStatus);

      if (statuses.length === 0) {
        console.log('No synced namespaces.');
        return;
      }

      console.log('Sync status:\n');
      for (const s of statuses) {
        const stateIcon = s.state === 'connected' ? '●' : s.state === 'disconnected' ? '○' : '◐';
        console.log(`  ${stateIcon} ${s.namespace}`);
        console.log(`    State: ${s.state}`);
        console.log(`    Peers: ${s.connectedPeers}`);
        if (s.lastSyncedAt) {
          console.log(`    Last synced: ${s.lastSyncedAt}`);
        }
        if (s.error) {
          console.log(`    Error: ${s.error}`);
        }
        console.log();
      }
    } catch {
      console.error('Failed to connect to server. Is it running?');
      process.exit(1);
    }
  });

// brain sync leave --namespace <ns>
syncCmd
  .command('leave')
  .description('Leave a sync room')
  .requiredOption('--namespace <namespace>', 'Namespace to stop syncing')
  .action(async (options: { namespace: string }) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/sync/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: options.namespace }),
      });

      if (!res.ok) {
        const err: unknown = await res.json().catch(() => ({ error: 'Leave failed' }));
        const message = isRecord(err) && typeof err.error === 'string'
          ? err.error
          : res.statusText;
        console.error(`Failed to leave sync: ${message}`);
        process.exit(1);
      }

      console.log(`Left sync for namespace "${options.namespace}"`);
    } catch {
      console.error('Failed to connect to server. Is it running?');
      process.exit(1);
    }
  });

// --- brain tail / brain poll (realtime adapters) ---
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

// --- brain co-ingest-claude-mem (optional) ---
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

// --- brain recall ---
program
  .command('recall')
  .description('Build a context block mimicking what SessionStart would inject')
  .option('-s, --session <id>', 'Session ID to include session:<id> in scope')
  .option('-q, --query <text>', 'Optional free-text query')
  .option('-n, --namespace <ns>', 'Additional namespace (repeatable)', (val, prev: string[]) => [...(prev ?? []), val], [] as string[])
  .option('-l, --limit <n>', 'Max entities', '15')
  .action(async (options: { session?: string; query?: string; namespace: string[]; limit: string }) => {
    const brain = openBrain();
    try {
      const namespaces = options.namespace.length > 0 ? options.namespace : ['personal'];
      const scope = Array.from(
        new Set([
          ...(options.session ? [`session:${options.session}`] : []),
          ...namespaces,
        ]),
      );
      const limit = parseInt(options.limit, 10);

      let hits: Array<{ entity: { id: string; type: string; name: string; namespace: string; observations: string[]; confidence: number; lastAccessedAt: string } }> = [];
      if (options.query && options.query.trim()) {
        const merged = new Map<string, { entity: { id: string; type: string; name: string; namespace: string; observations: string[]; confidence: number; lastAccessedAt: string }; score: number }>();
        for (const ns of scope) {
          const res = await brain.search.searchMulti({ query: options.query, namespace: ns, limit: limit * 2 });
          for (const r of res) {
            const prev = merged.get(r.entity.id);
            if (!prev || r.score > prev.score) merged.set(r.entity.id, r);
          }
        }
        hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((r) => ({ entity: r.entity }));
      } else {
        for (const ns of scope) {
          const list = brain.entities.list({ namespace: ns, limit: limit * 2 });
          list.sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
          for (const entity of list.slice(0, limit)) hits.push({ entity });
        }
        hits = hits.slice(0, limit);
      }
      if (hits.length === 0) {
        console.log('No prior context.');
        return;
      }
      console.log('## Prior context from second-brain');
      for (const h of hits) {
        const e = h.entity;
        console.log(`- [${e.type}] ${e.name} · ${e.id} · ns=${e.namespace}`);
        if (e.observations.length > 0) console.log(`  - ${e.observations[0]}`);
      }
    } finally {
      brain.close();
    }
  });

// --- brain install-hooks / uninstall-hooks ---
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
    const { installClaudeHooks } = await import('./install-hooks.js');
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

program
  .command('uninstall-hooks')
  .description('Remove hooks installed by `brain install-hooks`')
  .option('-s, --scope <scope>', 'user | project', 'user')
  .action(async (options: { scope?: 'user' | 'project' }) => {
    const { uninstallClaudeHooks } = await import('./install-hooks.js');
    const result = uninstallClaudeHooks({ scope: options.scope ?? 'user' });
    console.log(`Updated ${result.settingsPath}`);
    console.log(`Removed: ${result.removed.length ? result.removed.join(', ') : '(none)'}`);
  });

// --- brain watch ---
program
  .command('watch')
  .description('Run the file-change + branch-change daemon for a wired repo')
  .option('--repo <path>', 'Repo root (defaults to cwd)')
  .option('-n, --namespace <ns>', 'Override namespace (defaults to wired value or personal)')
  .option('--server-url <url>', 'Server URL (defaults to http://localhost:7430 or $SECOND_BRAIN_SERVER_URL)')
  .option('--token <token>', 'Bearer token (or $SECOND_BRAIN_TOKEN)')
  .option('--author-email <email>', 'Override git config user.email')
  .option('--author-name <name>', 'Override git config user.name')
  .action(async (options: {
    repo?: string;
    namespace?: string;
    serverUrl?: string;
    token?: string;
    authorEmail?: string;
    authorName?: string;
  }) => {
    const { runWatch } = await import('./git-context-daemon.js');
    const repo = options.repo ?? process.cwd();
    const handle = await runWatch({
      repo,
      namespace: options.namespace,
      serverUrl: options.serverUrl,
      bearerToken: options.token,
      authorEmail: options.authorEmail,
      authorName: options.authorName,
    });
    const currentBranch = await handle.currentBranch();
    console.log(`[watch] ready — repo=${repo} branch=${currentBranch}`);
    console.log('[watch] Press Ctrl-C to stop.');
    // Keep the process alive. SIGINT/SIGTERM handlers inside runWatch shut down cleanly.
  });

// --- brain wire ---
program
  .command('wire')
  .description('One-shot wire-up: git hooks + claude hooks + wiredRepos entry (+ optional GitLab provider)')
  .option('--repo <path>', 'Repo root (defaults to `git rev-parse --show-toplevel`)')
  .option('-n, --namespace <ns>', 'Namespace (overrides project config)')
  .option('--server-url <url>', 'Server URL')
  .option('--token <token>', 'Bearer token')
  .option('--require-project', 'Fail if no project namespace is set (for CI/team setups)')
  .option('--no-claude', 'Skip Claude Code session hook install')
  .option('--skip-if-claude-mem', 'Abort if claude-mem hooks are present')
  .option('--provider <name>', 'Forge provider to wire (gitlab)')
  .option('--gitlab-url <url>', 'GitLab base URL (auto-detected from origin when omitted)')
  .option('--gitlab-token <pat>', 'GitLab PAT (falls back to SECOND_BRAIN_GITLAB_TOKEN env)')
  .option('--gitlab-project-path <path>', 'group/subgroup/project (auto-detected when omitted)')
  .action(async (options: {
    repo?: string;
    namespace?: string;
    serverUrl?: string;
    token?: string;
    requireProject?: boolean;
    claude?: boolean;
    skipIfClaudeMem?: boolean;
    provider?: string;
    gitlabUrl?: string;
    gitlabToken?: string;
    gitlabProjectPath?: string;
  }) => {
    const { runWire } = await import('./wire.js');
    try {
      const result = await runWire({
        repo: options.repo,
        namespace: options.namespace,
        serverUrl: options.serverUrl,
        bearerToken: options.token,
        requireProject: options.requireProject,
        installClaudeSession: options.claude !== false,
        skipIfClaudeMem: options.skipIfClaudeMem,
        provider: options.provider === 'gitlab' ? 'gitlab' : undefined,
        gitlabBaseUrl: options.gitlabUrl,
        gitlabToken: options.gitlabToken,
        gitlabProjectPath: options.gitlabProjectPath,
      });
      console.log(`Wired: ${result.repoRoot}`);
      console.log(`  namespace: ${result.namespace}`);
      console.log(`  author:    ${result.authorEmail ?? '(not set)'}`);
      console.log(`  git hooks: ${result.gitHooks.installed.join(', ')}`);
      if (result.gitHooks.backups.length > 0) {
        console.log(
          `  backups:   ${result.gitHooks.backups.map((b) => `${b.name}→${b.path}`).join(', ')}`,
        );
      }
      if (result.claudeHooks) {
        console.log(
          `  claude hooks: ${result.claudeHooks.addedHooks.length ? result.claudeHooks.addedHooks.join(', ') : '(already present)'}`,
        );
      }
      if (result.providerResult) {
        const p = result.providerResult;
        console.log(
          `  provider:  ${p.provider} projectId=${p.projectId} hook=${p.webhookId}${p.webhookAlreadyExisted ? ' (reused)' : ''}`,
        );
        console.log(`  relay:     ${p.relayUrl}`);
      }
      console.log(`  config:    ${result.configPath}`);
      for (const w of result.warnings) {
        console.log(`  [warn] ${w}`);
      }
      console.log('');
      console.log('Next: start the file-watch daemon with:');
      console.log(`  ${result.watchCommand}`);
    } catch (err) {
      console.error(`wire failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// --- brain unwire ---
program
  .command('unwire')
  .description('Reverse `brain wire` — remove git hooks, drop wiredRepos entry, unregister webhook')
  .option('--repo <path>', 'Repo root')
  .option('--remove-claude-hooks', 'Also remove Claude Code session hooks (affects all repos)')
  .option('--purge', 'Signal that project observations should be purged (DB purge lands in 10.4)')
  .option('--force', 'Proceed past provider API failures (401, timeout). 404 is always success.')
  .action(
    async (options: {
      repo?: string;
      removeClaudeHooks?: boolean;
      purge?: boolean;
      force?: boolean;
    }) => {
      const { runUnwire } = await import('./unwire.js');
      try {
        const result = await runUnwire({
          repo: options.repo,
          removeClaudeHooks: options.removeClaudeHooks,
          purge: options.purge,
          force: options.force,
        });
        console.log(`Unwired: ${result.repoRoot}`);
        console.log(`  git hooks removed:  ${result.gitHooks.removed.join(', ') || '(none)'}`);
        if (result.gitHooks.restored.length > 0) {
          console.log(`  git hooks restored: ${result.gitHooks.restored.join(', ')}`);
        }
        console.log(`  config entry removed:  ${result.configEntryRemoved}`);
        console.log(`  provider unregistered: ${result.providerUnregistered}`);
        console.log(`  keychain cleaned:      ${result.keychainCleaned} entry/ies`);
        if (result.claudeRemoved) {
          console.log(`  claude hooks removed:  ${result.claudeRemoved.join(', ') || '(none)'}`);
        }
        for (const w of result.warnings) console.log(`  warning: ${w}`);
        if (options.purge) {
          console.log(`  [note] --purge requested but DB purge ships in sub-phase 10.4`);
        }
      } catch (err) {
        console.error(`brain unwire: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    },
  );

// --- brain flip-branch ---
program
  .command('flip-branch')
  .description('Manually flip branchContext.status on a branch (admin escape hatch).')
  .argument('<branch>', 'Branch name to flip (exact match)')
  .requiredOption('--status <status>', `One of: ${BRANCH_STATUSES.join(' | ')}`)
  .option('--mr <iid>', 'Optional MR/PR iid (numeric)')
  .option('--merged-at <iso>', 'ISO timestamp (when --status=merged)')
  .action(
    (
      branchName: string,
      options: { status: string; mr?: string; mergedAt?: string },
    ) => {
      let patch: BranchStatusPatch;
      try {
        patch = BranchStatusPatchSchema.parse({
          status: options.status,
          mrIid: options.mr ? Number(options.mr) : null,
          mergedAt: options.mergedAt ?? null,
        });
      } catch (err) {
        console.error(`Invalid arguments: ${(err as Error).message}`);
        process.exit(1);
      }
      const brain = openBrain();
      try {
        const result = brain.flipBranchStatus(branchName, patch);
        console.log(
          `Flipped "${branchName}" → ${patch.status}. ` +
            `entities=${result.updatedEntities} relations=${result.updatedRelations}`,
        );
      } finally {
        brain.close();
      }
    },
  );

// --- brain ownership ---
program
  .command('ownership')
  .description('Show file ownership scores')
  .argument('<path>', 'Repository-relative file path')
  .option('-l, --limit <n>', 'Max owners to return', '3')
  .option('--json', 'Output as JSON')
  .option('--server-url <url>', 'Server URL (default: http://localhost:7430)')
  .option('--token <token>', 'Bearer token')
  .action(
    async (
      filePath: string,
      options: {
        limit?: string;
        json?: boolean;
        serverUrl?: string;
        token?: string;
      },
    ) => {
      const { runOwnership } = await import('./ownership.js');
      await runOwnership({
        path: filePath,
        limit: options.limit ? Number(options.limit) : undefined,
        json: options.json,
        serverUrl: options.serverUrl,
        token: options.token,
      });
    },
  );

// --- brain personal ---
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
    const { runPersonalExport } = await import('./personal.js');
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
    const { runPersonalImport } = await import('./personal.js');
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
    const { runPersonalStats } = await import('./personal.js');
    const brain = openBrain();
    try {
      await runPersonalStats(brain, options);
    } finally {
      brain.close();
    }
  });

program.parse();
