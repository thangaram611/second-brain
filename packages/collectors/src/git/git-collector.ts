import { simpleGit } from 'simple-git';
import type { SimpleGit, DefaultLogFields, ListLogLine } from 'simple-git';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { Collector, ExtractionResult, PipelineConfig, PendingRelation } from '@second-brain/ingestion';
import { CoChangeTracker } from './co-change-tracker.js';

export interface GitCollectorOptions {
  /** Maximum number of recent commits to process */
  maxCommits?: number;
}

function shouldIgnore(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Simple glob: treat pattern as a prefix/substring match
    // Supports patterns like "node_modules", "dist/", "*.lock"
    if (pattern.startsWith('*')) {
      return filePath.endsWith(pattern.slice(1));
    }
    return filePath.includes(pattern);
  });
}

export class GitCollector implements Collector {
  readonly name = 'git';
  private options: GitCollectorOptions;

  constructor(options?: GitCollectorOptions) {
    this.options = { maxCommits: 50, ...options };
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const repoPath = config.repoPath ?? process.cwd();
    const git: SimpleGit = simpleGit(repoPath);
    const entities: CreateEntityInput[] = [];
    const relations: PendingRelation[] = [];
    const coChangeTracker = new CoChangeTracker();

    const source: EntitySource = { type: 'git', ref: repoPath };
    const seenPersons = new Set<string>();
    const seenFiles = new Set<string>();

    // Get recent commits
    const log = await git.log({ maxCount: this.options.maxCommits });

    for (const commit of log.all) {
      const commitHash = commit.hash;
      const authorName = commit.author_name;
      const authorEmail = commit.author_email;
      const commitDate = commit.date;
      const message = commit.message;

      // Person entity (deduplicated by name)
      const personKey = `${authorName}<${authorEmail}>`;
      if (!seenPersons.has(personKey)) {
        seenPersons.add(personKey);
        entities.push({
          type: 'person',
          name: authorName,
          namespace: config.namespace,
          observations: [`Email: ${authorEmail}`],
          properties: { email: authorEmail },
          source: { type: 'git', ref: commitHash, actor: authorName },
          tags: ['git-author'],
        });
      }

      // Event entity for the commit
      entities.push({
        type: 'event',
        name: `commit:${commitHash.slice(0, 8)}`,
        namespace: config.namespace,
        observations: [message],
        properties: { hash: commitHash, authorName, authorEmail },
        eventTime: commitDate,
        source: { type: 'git', ref: commitHash, actor: authorName },
        tags: ['git-commit'],
      });

      // authored_by: commit -> person
      relations.push({
        type: 'authored_by',
        sourceName: `commit:${commitHash.slice(0, 8)}`,
        sourceType: 'event',
        targetName: authorName,
        targetType: 'person',
        source: { type: 'git', ref: commitHash },
        namespace: config.namespace,
      });

      // Get files changed in this commit
      let changedFiles: string[] = [];
      try {
        const diff = await git.diffSummary([`${commitHash}~1`, commitHash]);
        changedFiles = diff.files
          .map((f) => f.file)
          .filter((f) => !shouldIgnore(f, config.ignorePatterns));
      } catch {
        // First commit has no parent — use show instead
        try {
          const show = await git.show(['--name-only', '--format=', commitHash]);
          changedFiles = show
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .filter((f) => !shouldIgnore(f, config.ignorePatterns));
        } catch {
          // Skip if we can't get file list
        }
      }

      // File entities
      for (const filePath of changedFiles) {
        if (!seenFiles.has(filePath)) {
          seenFiles.add(filePath);
          entities.push({
            type: 'file',
            name: filePath,
            namespace: config.namespace,
            observations: [],
            properties: { path: filePath },
            source: { type: 'git', ref: commitHash },
            tags: classifyFile(filePath),
          });
        }

        // contains: commit -> file
        relations.push({
          type: 'contains',
          sourceName: `commit:${commitHash.slice(0, 8)}`,
          sourceType: 'event',
          targetName: filePath,
          targetType: 'file',
          source: { type: 'git', ref: commitHash },
          namespace: config.namespace,
        });
      }

      // Track co-changes
      if (changedFiles.length >= 2) {
        coChangeTracker.recordCommit(changedFiles);
      }
    }

    // Add co-change relations
    const coChangeRelations = coChangeTracker.toRelations(source, config.namespace);
    relations.push(...coChangeRelations);

    return { entities, relations };
  }
}

function classifyFile(filePath: string): string[] {
  const tags: string[] = [];
  const lower = filePath.toLowerCase();

  if (lower.includes('test') || lower.includes('spec')) tags.push('test');
  if (lower.includes('config') || lower.endsWith('.config.ts') || lower.endsWith('.config.js')) tags.push('config');
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) tags.push('docs');
  if (lower.includes('component') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) tags.push('component');
  if (lower.includes('util') || lower.includes('helper') || lower.includes('lib/')) tags.push('util');

  return tags;
}
