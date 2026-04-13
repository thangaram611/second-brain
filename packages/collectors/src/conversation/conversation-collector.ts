import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CreateEntityInput, EntitySource } from '@second-brain/types';
import type { Collector, ExtractionResult, PendingRelation, PipelineConfig } from '@second-brain/ingestion';
import { LLMExtractor } from '@second-brain/ingestion';
import {
  parseClaudeConversation,
  conversationToText,
  type ParsedConversation,
} from './claude-parser.js';
import { parseGenericConversation } from './generic-parser.js';

export type ConversationFormat = 'claude' | 'generic';

export interface ConversationCollectorOptions {
  /** Directory containing .jsonl conversation logs. Defaults to `~/.claude/projects/`. */
  source?: string;
  /** Process a single file (overrides directory scan). */
  file?: string;
  /** Format hint. Defaults to 'claude' for files under ~/.claude, 'generic' otherwise. */
  format?: ConversationFormat;
  /** LLM extractor used to pull decisions/facts/patterns from conversation prose. */
  extractor: LLMExtractor;
  /** Maximum conversations to process in a single run. Default 20. */
  maxConversations?: number;
  /** Maximum file size to attempt to process (bytes). Default 5MB. */
  maxFileBytes?: number;
}

/**
 * Walks Claude Code (and generic JSONL) conversation logs and emits:
 *  - 1 conversation entity per session (with summary observation)
 *  - decision/fact/pattern entities extracted by the LLM
 *  - decided_in / derived_from relations linking them
 */
export class ConversationCollector implements Collector {
  readonly name = 'conversation';

  constructor(private options: ConversationCollectorOptions) {
    if (!options.extractor) {
      throw new Error('ConversationCollector requires an LLMExtractor (options.extractor)');
    }
  }

  async collect(config: PipelineConfig): Promise<ExtractionResult> {
    const merged: ExtractionResult = { entities: [], relations: [] };

    const files = await this.discoverFiles();
    const limit = this.options.maxConversations ?? 20;
    const slice = files.slice(0, limit);

    for (let i = 0; i < slice.length; i++) {
      const file = slice[i];
      try {
        const result = await this.processFile(file, config.namespace);
        if (result) {
          merged.entities.push(...result.entities);
          merged.relations.push(...result.relations);
        }
      } catch {
        // Per-file failures shouldn't abort the run.
      }

      if (config.onProgress) {
        config.onProgress({
          stage: 'collecting',
          collector: this.name,
          current: i + 1,
          total: slice.length,
          message: `processed ${path.basename(file)}`,
        });
      }
    }

    return merged;
  }

  private async discoverFiles(): Promise<string[]> {
    if (this.options.file) {
      return [path.resolve(expandHome(this.options.file))];
    }
    const dir = path.resolve(expandHome(this.options.source ?? '~/.claude/projects/'));
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) return [];

    const files: string[] = [];
    const queue: string[] = [dir];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
      }
    }
    // Most-recent first.
    const stats = await Promise.all(
      files.map(async (f) => ({ f, mtime: (await fs.stat(f)).mtimeMs })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats.map((s) => s.f);
  }

  private async processFile(filePath: string, namespace: string): Promise<ExtractionResult | null> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return null;
    if (stat.size > (this.options.maxFileBytes ?? 5 * 1024 * 1024)) return null;

    const content = await fs.readFile(filePath, 'utf-8');
    const format = this.options.format ?? inferFormat(filePath);
    const fallbackId = path.basename(filePath, path.extname(filePath));
    const convo =
      format === 'claude'
        ? parseClaudeConversation(content, fallbackId)
        : parseGenericConversation(content, fallbackId);
    if (!convo) return null;

    const source: EntitySource = {
      type: 'conversation',
      ref: filePath,
      actor: convo.projectPath,
    };

    const convoEntity: CreateEntityInput = {
      type: 'conversation',
      name: `Session ${convo.sessionId}`,
      namespace,
      observations: buildSessionObservations(convo),
      properties: {
        sessionId: convo.sessionId,
        projectPath: convo.projectPath,
        turnCount: convo.turns.length,
        format,
      },
      tags: ['conversation', format],
      source,
    };

    const entities: CreateEntityInput[] = [convoEntity];
    const relations: PendingRelation[] = [];

    const text = conversationToText(convo);
    if (text.trim().length > 0) {
      const extracted = await this.options.extractor.extract(text, { namespace, source });
      entities.push(...extracted.entities);
      relations.push(...extracted.relations);

      // Link extracted decisions/facts/patterns back to the conversation entity.
      for (const e of extracted.entities) {
        if (e.type === 'decision') {
          relations.push({
            type: 'decided_in',
            sourceName: e.name,
            sourceType: 'decision',
            targetName: convoEntity.name,
            targetType: 'conversation',
            namespace,
            source,
          });
        } else if (e.type === 'fact' || e.type === 'pattern' || e.type === 'concept') {
          relations.push({
            type: 'derived_from',
            sourceName: e.name,
            sourceType: e.type,
            targetName: convoEntity.name,
            targetType: 'conversation',
            namespace,
            source,
          });
        }
      }
    }

    return { entities, relations };
  }
}

function buildSessionObservations(convo: ParsedConversation): string[] {
  const out: string[] = [`${convo.turns.length} turns`];
  if (convo.projectPath) out.push(`project: ${convo.projectPath}`);
  const firstUser = convo.turns.find((t) => t.role === 'user');
  if (firstUser) {
    const snippet = firstUser.content.slice(0, 200);
    out.push(`opening prompt: ${snippet}${firstUser.content.length > 200 ? '…' : ''}`);
  }
  return out;
}

function inferFormat(filePath: string): ConversationFormat {
  if (filePath.includes(`${path.sep}.claude${path.sep}`)) return 'claude';
  return 'generic';
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
