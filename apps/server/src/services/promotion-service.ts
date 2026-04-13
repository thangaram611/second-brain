import type { Brain, PromoteSessionResult } from '@second-brain/core';
import type { LLMExtractor } from '@second-brain/ingestion';
import { sessionNamespace, isSessionNamespace, type Entity } from '@second-brain/types';

export interface PromotionServiceOptions {
  confidenceMin?: number;
  maxReplayChars?: number;
}

export interface FinalizeSessionOptions {
  targetNamespace: string;
}

export interface FinalizeSessionResult {
  promotion: PromoteSessionResult;
  summary: string;
}

/**
 * Session-end finalizer. Replays the session conversation + events into the
 * LLM extractor to distill canonical decision/fact/pattern entities, filters
 * by confidence, then rewrites those entities' namespace to the target.
 *
 * If no LLM extractor is available, falls back to a no-extract promotion
 * pathway that just moves high-confidence entities out of session namespace.
 */
export class PromotionService {
  private readonly confidenceMin: number;
  private readonly maxReplayChars: number;

  constructor(
    private brain: Brain,
    private extractor: LLMExtractor | null,
    options: PromotionServiceOptions = {},
  ) {
    this.confidenceMin = options.confidenceMin ?? 0.6;
    this.maxReplayChars = options.maxReplayChars ?? 24_000;
  }

  async finalizeSession(
    sessionId: string,
    options: FinalizeSessionOptions,
  ): Promise<FinalizeSessionResult> {
    const ns = sessionNamespace(sessionId);
    const target = options.targetNamespace;

    const sessionEntities = this.brain.entities.list({ namespace: ns, limit: 100_000 });
    if (sessionEntities.length === 0) {
      return {
        promotion: { promotedEntities: 0, promotedRelations: 0, skipped: 0 },
        summary: '',
      };
    }

    if (this.extractor) {
      const text = this.buildReplayText(sessionEntities);
      try {
        const extracted = await this.extractor.extract(text, {
          namespace: target,
          source: { type: 'conversation', ref: sessionId },
        });
        for (const ent of extracted.entities) {
          if ((ent.confidence ?? 1.0) < this.confidenceMin) continue;
          this.brain.entities.batchUpsert([{ ...ent, namespace: target }]);
        }
      } catch {
        // Fall through to namespace rewrite below — don't fail session-end.
      }
    }

    // Rewrite the raw session-scoped decision/fact/pattern entities (these are
    // the high-signal types) into the target namespace so they show up in
    // cross-session recall. Keep event/conversation/reference local to session
    // for audit — they're TTL'd separately by GC.
    const promotion = this.brain.promoteSession(sessionId, target, {
      entityTypeFilter: ['decision', 'fact', 'pattern'],
    });

    const summary = this.buildSummary(sessionEntities);
    // Tag the conversation entity with a pointer to what was promoted.
    const conv = sessionEntities.find((e) => e.type === 'conversation');
    if (conv && isSessionNamespace(conv.namespace)) {
      this.brain.entities.update(conv.id, {
        properties: {
          ...conv.properties,
          endedAt: new Date().toISOString(),
          promoted: promotion,
          target,
        },
      });
    }

    return { promotion, summary };
  }

  private buildReplayText(entities: Entity[]): string {
    const sorted = entities
      .slice()
      .sort(
        (a, b) =>
          new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime(),
      );

    const parts: string[] = [];
    for (const e of sorted) {
      if (e.type === 'conversation') {
        for (const obs of e.observations) parts.push(obs);
      } else if (e.type === 'event') {
        parts.push(`[tool ${e.name}] ${e.observations.join(' | ')}`);
      } else {
        parts.push(`[${e.type}] ${e.name}: ${e.observations.join(' | ')}`);
      }
      if (parts.join('\n').length > this.maxReplayChars) break;
    }
    return parts.join('\n').slice(0, this.maxReplayChars);
  }

  private buildSummary(entities: Entity[]): string {
    const toolCounts = new Map<string, number>();
    for (const e of entities) {
      if (e.type === 'event') {
        const name = String(e.properties?.toolName ?? e.name);
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      }
    }
    const tools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([n, c]) => `${n}×${c}`)
      .join(', ');
    return `session entities=${entities.length}; tools=${tools}`;
  }
}
