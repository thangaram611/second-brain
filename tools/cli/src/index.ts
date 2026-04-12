#!/usr/bin/env node

import { Command } from 'commander';
import { Brain } from '@second-brain/core';
import type { EntityType, CreateEntityInput } from '@second-brain/types';
import { ENTITY_TYPES } from '@second-brain/types';
import { PipelineRunner, GitCollector, ASTCollector } from '@second-brain/ingestion';
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

program.parse();
