#!/usr/bin/env node

import { Command } from 'commander';
import { Brain, exportJson, exportJsonLd, exportDot, importGraph, VectorSearchChannel } from '@second-brain/core';
import type { EntityType, CreateEntityInput } from '@second-brain/types';
import { ENTITY_TYPES } from '@second-brain/types';
import {
  PipelineRunner,
  GitCollector,
  ASTCollector,
  DocCollector,
  ConversationCollector,
  GitHubCollector,
  LLMExtractor,
  EmbeddingGenerator,
  EmbedPipeline,
  resolveLLMConfig,
} from '@second-brain/ingestion';
import type { PipelineProgress } from '@second-brain/ingestion';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.second-brain');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'personal.db');

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

// --- brain init ---
program
  .command('init')
  .description('Initialize a new brain')
  .option('-p, --project <name>', 'Initialize as a project brain')
  .option('--db <path>', 'Custom database path')
  .action((options: { project?: string; db?: string }) => {
    const dbPath = options.db ?? DEFAULT_DB_PATH;
    const dir = path.dirname(dbPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(dbPath)) {
      console.log(`Brain already exists at ${dbPath}`);
      return;
    }

    const brain = new Brain({ path: dbPath });
    brain.close();

    console.log(`Brain initialized at ${dbPath}`);
    if (options.project) {
      console.log(`Project namespace: ${options.project}`);
    }
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
      const collector = options.enrich
        ? new DocCollector({
            watchPaths: options.path,
            llmEnrich: true,
            extractor: new LLMExtractor(resolveLLMConfig()),
          })
        : new DocCollector({ watchPaths: options.path });
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
      const runner = new PipelineRunner(brain);
      runner.register(
        new ConversationCollector({
          source: options.source,
          file: options.file,
          extractor: new LLMExtractor(resolveLLMConfig()),
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
      runner.register(
        new GitHubCollector({
          repo: options.repo,
          token: options.token,
          maxPRs: parseInt(options.maxPrs, 10),
          maxIssues: parseInt(options.maxIssues, 10),
          state: stateOpt,
          extractor: options.enrich ? new LLMExtractor(resolveLLMConfig()) : undefined,
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
      const generator = new EmbeddingGenerator(cfg);
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
        const extractor = new LLMExtractor(cfg, {
          systemPrompt: 'Extract 1-3 short search keywords from this question as entity names.',
          maxInputChars: 1000,
        });
        const probe = await extractor.extract(question, {
          namespace: options.namespace,
          source: { type: 'manual' },
        });
        if (probe.entities.length > 0) {
          queryText = probe.entities.map((e) => e.name).join(' ');
          usedLlm = true;
        }
        if (options.vector && brain.embeddings !== null && !brain.search.hasVectorChannel()) {
          const generator = new EmbeddingGenerator(cfg);
          brain.search.setVectorChannel(
            new VectorSearchChannel(brain.embeddings, brain.entities, (q) =>
              generator.generateOne(q),
            ),
          );
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

program.parse();
