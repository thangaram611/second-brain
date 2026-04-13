import type { Brain, PromoteSessionResult } from '@second-brain/core';
import type { Entity, EntitySource, SearchResult } from '@second-brain/types';
import { sessionNamespace } from '@second-brain/types';
import { SerialQueue } from './serial-queue.js';
import type { PromotionService } from './promotion-service.js';

export interface SessionStartPayload {
  sessionId: string;
  cwd?: string;
  tool?: 'claude' | 'codex' | 'copilot' | 'gemini' | string;
  hookVersion?: string;
  timestamp?: string;
  /** Optional project identifier — used as promotion target when set. */
  project?: string;
}

export interface PromptSubmitPayload {
  sessionId: string;
  prompt: string;
  timestamp?: string;
}

export interface ToolUsePayload {
  sessionId: string;
  toolName: string;
  phase: 'pre' | 'post' | 'unknown';
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  timestamp?: string;
  filePaths?: string[];
}

export interface SessionEndPayload {
  sessionId: string;
  reason?: string;
  timestamp?: string;
}

export interface StopPayload {
  sessionId: string;
  timestamp?: string;
}

export interface ObservationServiceOptions {
  retentionDays?: number;
  /** Override the current time for testability. */
  now?: () => string;
  /** Namespaces to include when building SessionStart context block. */
  contextNamespaces?: string[];
  /** Max entities in a context block. */
  contextLimit?: number;
}

export interface ObservationCounters {
  hook_events_total: number;
  hook_events_dropped_ratelimit: number;
  private_blocks_filtered: number;
  tail_lines_processed: number;
  promoted_entities_total: number;
}

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

/** Strip <private>...</private> blocks from free text before persistence. */
export function stripPrivateBlocks(text: string): { redacted: string; stripped: number } {
  let stripped = 0;
  const redacted = text.replace(PRIVATE_TAG_RE, () => {
    stripped++;
    return '';
  });
  return { redacted, stripped };
}

/**
 * Write-path service for realtime hook/adapter events. Fast-path is synchronous
 * SQLite; LLM extraction is serialized per-session on an in-process queue.
 */
export class ObservationService {
  private conversationBySession: Map<string, string> = new Map();
  private projectBySession: Map<string, string> = new Map();
  private queue: SerialQueue<string> = new SerialQueue<string>();

  readonly counters: ObservationCounters = {
    hook_events_total: 0,
    hook_events_dropped_ratelimit: 0,
    private_blocks_filtered: 0,
    tail_lines_processed: 0,
    promoted_entities_total: 0,
  };

  readonly retentionDays: number;
  private readonly now: () => string;
  private readonly contextNamespaces: string[];
  private readonly contextLimit: number;

  constructor(
    private brain: Brain,
    private promotion: PromotionService,
    options: ObservationServiceOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? 30;
    this.now = options.now ?? (() => new Date().toISOString());
    this.contextNamespaces = options.contextNamespaces ?? ['personal'];
    this.contextLimit = options.contextLimit ?? 15;
  }

  private sourceFor(tool?: string): EntitySource {
    const actor = tool ?? 'claude';
    return { type: 'conversation', ref: actor };
  }

  /** Ensure a conversation entity exists for the session; return its ID. */
  private ensureConversationEntity(sessionId: string, payload?: SessionStartPayload): string {
    const existingId = this.conversationBySession.get(sessionId);
    if (existingId) return existingId;

    const ns = sessionNamespace(sessionId);
    // Look up by name+namespace+type in case we're restarting after a crash.
    const matches = this.brain.entities.findByName(`session:${sessionId}`, ns);
    const existing = matches.find((e) => e.type === 'conversation');
    if (existing) {
      this.conversationBySession.set(sessionId, existing.id);
      return existing.id;
    }

    const entity = this.brain.entities.create({
      type: 'conversation',
      name: `session:${sessionId}`,
      namespace: ns,
      observations: [],
      properties: {
        sessionId,
        tool: payload?.tool ?? 'claude',
        cwd: payload?.cwd,
        hookVersion: payload?.hookVersion,
        startedAt: payload?.timestamp ?? this.now(),
        ...(payload?.project ? { project: payload.project } : {}),
      },
      tags: ['session', `tool:${payload?.tool ?? 'claude'}`],
      source: this.sourceFor(payload?.tool),
    });
    this.conversationBySession.set(sessionId, entity.id);
    if (payload?.project) this.projectBySession.set(sessionId, payload.project);
    return entity.id;
  }

  async handleSessionStart(
    payload: SessionStartPayload,
  ): Promise<{ conversationId: string; namespace: string; contextBlock: string }> {
    this.counters.hook_events_total++;
    const conversationId = this.ensureConversationEntity(payload.sessionId, payload);
    const contextBlock = await this.buildStartContextBlock(payload);
    return {
      conversationId,
      namespace: sessionNamespace(payload.sessionId),
      contextBlock,
    };
  }

  async buildStartContextBlock(payload: SessionStartPayload): Promise<string> {
    const namespaces = payload.project
      ? Array.from(new Set([payload.project, ...this.contextNamespaces]))
      : this.contextNamespaces;

    const list: SearchResult[] = [];
    for (const ns of namespaces) {
      const entities = this.brain.entities.list({ namespace: ns, limit: this.contextLimit * 2 });
      entities.sort(
        (a, b) =>
          new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
      );
      for (const entity of entities.slice(0, this.contextLimit)) {
        list.push({ entity, score: entity.confidence, matchChannel: 'fulltext' });
      }
    }
    const top = list.slice(0, this.contextLimit);
    if (top.length === 0) return '';

    const lines: string[] = ['## Prior context from second-brain'];
    for (const h of top) {
      const e = h.entity;
      lines.push(`- [${e.type}] **${e.name}** · ${e.id} · ns=${e.namespace}`);
      if (e.observations.length > 0) {
        lines.push(`  - ${e.observations[0]}`);
      }
    }
    return lines.join('\n');
  }

  handlePromptSubmit(payload: PromptSubmitPayload): { conversationId: string } {
    this.counters.hook_events_total++;
    const { redacted, stripped } = stripPrivateBlocks(payload.prompt);
    if (stripped > 0) this.counters.private_blocks_filtered += stripped;

    const conversationId = this.ensureConversationEntity(payload.sessionId);
    if (redacted.trim()) {
      this.brain.entities.addObservation(conversationId, `user: ${redacted}`);
    }
    return { conversationId };
  }

  handleToolUse(payload: ToolUsePayload): { eventId: string } {
    this.counters.hook_events_total++;
    const ns = sessionNamespace(payload.sessionId);
    const convId = this.ensureConversationEntity(payload.sessionId);

    const event = this.brain.entities.create({
      type: 'event',
      name: `${payload.toolName}:${payload.phase}`,
      namespace: ns,
      observations: buildToolObservations(payload),
      properties: {
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        phase: payload.phase,
        durationMs: payload.durationMs,
        input: payload.input,
        output: payload.output,
      },
      tags: ['tool-use', `tool:${payload.toolName}`, `phase:${payload.phase}`],
      source: { type: 'conversation', ref: payload.toolName },
    });

    this.brain.relations.create({
      type: 'decided_in',
      sourceId: event.id,
      targetId: convId,
      namespace: ns,
      source: { type: 'conversation', ref: payload.toolName },
    });

    for (const filePath of payload.filePaths ?? []) {
      const file = this.upsertFileEntity(ns, filePath);
      this.brain.relations.create({
        type: 'uses',
        sourceId: event.id,
        targetId: file.id,
        namespace: ns,
        properties: { toolName: payload.toolName, phase: payload.phase },
        source: { type: 'conversation', ref: payload.toolName },
      });
    }

    return { eventId: event.id };
  }

  private upsertFileEntity(ns: string, filePath: string): Entity {
    const matches = this.brain.entities.findByName(filePath, ns);
    const existing = matches.find((e) => e.type === 'file' && e.name === filePath);
    if (existing) return existing;
    return this.brain.entities.create({
      type: 'file',
      name: filePath,
      namespace: ns,
      observations: [],
      properties: { path: filePath },
      tags: ['file'],
      source: { type: 'conversation' },
    });
  }

  handleStop(payload: StopPayload): { ok: true } {
    this.counters.hook_events_total++;
    const convId = this.conversationBySession.get(payload.sessionId);
    if (convId) {
      this.brain.entities.update(convId, {
        properties: {
          ...(this.brain.entities.get(convId)?.properties ?? {}),
          stoppedAt: payload.timestamp ?? this.now(),
        },
      });
    }
    return { ok: true };
  }

  async handleSessionEnd(
    payload: SessionEndPayload,
  ): Promise<{ promotion: PromoteSessionResult; summary: string }> {
    this.counters.hook_events_total++;
    const sessionId = payload.sessionId;
    const project = this.projectBySession.get(sessionId);

    const result = await this.queue.enqueue(sessionId, () =>
      this.promotion.finalizeSession(sessionId, { targetNamespace: project ?? 'personal' }),
    );

    this.counters.promoted_entities_total += result.promotion.promotedEntities;
    this.conversationBySession.delete(sessionId);
    this.projectBySession.delete(sessionId);

    // Opportunistic GC of stale session namespaces.
    try {
      this.brain.storage.sqlite
        .prepare(`DELETE FROM entities WHERE namespace LIKE 'session:%' AND updated_at < ?`)
        .run(this.expiryCutoff());
    } catch {
      // Best-effort; never fail session-end on GC.
    }

    return result;
  }

  private expiryCutoff(): string {
    return new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
  }

  /**
   * GC expired session namespaces (entities only — FK cascades remove relations
   * and embeddings). Returns the number of deleted entities. Idempotent.
   */
  gcExpiredSessions(): number {
    const result = this.brain.storage.sqlite
      .prepare(`DELETE FROM entities WHERE namespace LIKE 'session:%' AND updated_at < ?`)
      .run(this.expiryCutoff());
    return Number(result.changes ?? 0);
  }

  /** Used by the rate-limit middleware to count drops. */
  noteRateLimitDrop(): void {
    this.counters.hook_events_dropped_ratelimit++;
  }
}

function buildToolObservations(payload: ToolUsePayload): string[] {
  const out: string[] = [];
  out.push(`tool=${payload.toolName} phase=${payload.phase}`);
  if (payload.durationMs !== undefined) out.push(`duration=${payload.durationMs}ms`);
  if (payload.filePaths?.length) out.push(`files=${payload.filePaths.join(',')}`);
  return out;
}
