import type { Brain, PromoteSessionResult } from '@second-brain/core';
import type { Author, BranchContext, Entity, EntitySource, SearchResult } from '@second-brain/types';
import { sessionNamespace } from '@second-brain/types';
import { SerialQueue } from './serial-queue.js';
import type { PromotionService } from './promotion-service.js';
import { resolveAuthor } from '../lib/resolve-author.js';

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

export interface FileChangePayload {
  /** Absolute path of the repo root — used to resolve namespace + author. */
  repo: string;
  branch: string;
  /** Optional explicit author; when omitted the daemon-resolved cached author is used. */
  author?: Author;
  /** Namespace to write into — resolved by the caller from wiredRepos. */
  namespace: string;
  changes: Array<{
    path: string;
    kind: 'add' | 'change' | 'unlink';
    size?: number;
    mtime: string;
  }>;
  batchedAt: string;
  /** Dedup key: hash(filePath, mtime, branchAtBatch). Rejected on duplicate. */
  idempotencyKey: string;
}

export interface BranchChangePayload {
  repo: string;
  namespace: string;
  from: string;
  to: string;
  headSha: string;
  author?: Author;
  timestamp?: string;
}

export interface GitEventPayload {
  repo: string;
  namespace: string;
  kind: 'commit' | 'merge' | 'checkout';
  branch: string;
  headSha: string;
  message?: string;
  author?: Author;
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
  file_change_batches_total: number;
  file_change_batches_dedup: number;
  branch_change_events_total: number;
  git_events_total: number;
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
  private currentAuthor: Map<string, Author> = new Map();
  private seenIdempotencyKeys: Map<string, number> = new Map();
  private queue: SerialQueue<string> = new SerialQueue<string>();

  readonly counters: ObservationCounters = {
    hook_events_total: 0,
    hook_events_dropped_ratelimit: 0,
    private_blocks_filtered: 0,
    tail_lines_processed: 0,
    promoted_entities_total: 0,
    file_change_batches_total: 0,
    file_change_batches_dedup: 0,
    branch_change_events_total: 0,
    git_events_total: 0,
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

  private sourceFor(tool?: string, sessionId?: string): EntitySource {
    const actor = sessionId ? this.currentAuthor.get(sessionId)?.canonicalEmail : undefined;
    const ref = tool ?? 'claude';
    const base: EntitySource = { type: 'conversation', ref };
    return actor ? { ...base, actor } : base;
  }

  /** Exposed for routes + other services — returns the cached author for a session. */
  getAuthor(sessionId: string): Author | undefined {
    return this.currentAuthor.get(sessionId);
  }

  /** Exposed for tests + CLI — seed the author cache (skips git lookup). */
  setAuthor(sessionId: string, author: Author): void {
    this.currentAuthor.set(sessionId, author);
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
      source: this.sourceFor(payload?.tool, sessionId),
    });
    this.conversationBySession.set(sessionId, entity.id);
    if (payload?.project) this.projectBySession.set(sessionId, payload.project);
    return entity.id;
  }

  async handleSessionStart(
    payload: SessionStartPayload,
  ): Promise<{ conversationId: string; namespace: string; contextBlock: string }> {
    this.counters.hook_events_total++;
    // Resolve author once per session (git config read) so every subsequent
    // write in this session stamps source.actor without re-running git.
    if (payload.cwd && !this.currentAuthor.has(payload.sessionId)) {
      const author = await resolveAuthor(payload.cwd);
      if (author) this.currentAuthor.set(payload.sessionId, author);
    }
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
    const actor = this.currentAuthor.get(payload.sessionId)?.canonicalEmail;
    const hookSource: EntitySource = actor
      ? { type: 'hook', ref: payload.toolName, actor }
      : { type: 'hook', ref: payload.toolName };

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
      source: hookSource,
    });

    this.brain.relations.create({
      type: 'decided_in',
      sourceId: event.id,
      targetId: convId,
      namespace: ns,
      source: hookSource,
    });

    for (const filePath of payload.filePaths ?? []) {
      const file = this.upsertFileEntity(ns, filePath, actor);
      this.brain.relations.create({
        type: 'uses',
        sourceId: event.id,
        targetId: file.id,
        namespace: ns,
        properties: { toolName: payload.toolName, phase: payload.phase },
        source: hookSource,
      });
    }

    return { eventId: event.id };
  }

  private upsertFileEntity(ns: string, filePath: string, actor?: string): Entity {
    const matches = this.brain.entities.findByName(filePath, ns);
    const existing = matches.find((e) => e.type === 'file' && e.name === filePath);
    if (existing) return existing;
    const source: EntitySource = actor
      ? { type: 'conversation', actor }
      : { type: 'conversation' };
    return this.brain.entities.create({
      type: 'file',
      name: filePath,
      namespace: ns,
      observations: [],
      properties: { path: filePath },
      tags: ['file'],
      source,
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
    this.currentAuthor.delete(sessionId);

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

  /**
   * Dedup a file-change batch by idempotencyKey — true if this is a new
   * batch, false if we've already seen it within the dedup window.
   * Window is a rolling 5-minute cache (enough for hook retries + webhook
   * redeliveries; idempotencyKey itself is mtime-based so stale retries
   * never collide across batches).
   */
  private shouldAcceptBatch(key: string): boolean {
    const now = Date.now();
    const expiry = now - 5 * 60_000;
    for (const [k, seenAt] of this.seenIdempotencyKeys) {
      if (seenAt < expiry) this.seenIdempotencyKeys.delete(k);
    }
    if (this.seenIdempotencyKeys.has(key)) return false;
    this.seenIdempotencyKeys.set(key, now);
    return true;
  }

  handleFileChange(payload: FileChangePayload): { accepted: boolean; eventId?: string } {
    this.counters.file_change_batches_total++;
    if (!this.shouldAcceptBatch(payload.idempotencyKey)) {
      this.counters.file_change_batches_dedup++;
      return { accepted: false };
    }
    const actor = payload.author?.canonicalEmail;
    const source: EntitySource = actor
      ? { type: 'watch', ref: payload.repo, actor }
      : { type: 'watch', ref: payload.repo };

    const branchContext: BranchContext = {
      branch: payload.branch,
      status: 'wip',
      mrIid: null,
      mergedAt: null,
    };

    const event = this.brain.entities.create({
      type: 'event',
      name: `file-edit:${payload.branch}@${payload.batchedAt}`,
      namespace: payload.namespace,
      observations: payload.changes.map((c) => `${c.kind} ${c.path}`),
      properties: {
        branchContext,
        repo: payload.repo,
        batchedAt: payload.batchedAt,
        changeCount: payload.changes.length,
        idempotencyKey: payload.idempotencyKey,
      },
      tags: ['file-edit', `branch:${payload.branch}`],
      source,
    });

    for (const change of payload.changes) {
      const file = this.upsertFileEntity(payload.namespace, change.path, actor);
      // Stamp the file entity with latest branchContext so branch-aware queries
      // find it even without going through the event.
      this.brain.entities.update(file.id, {
        properties: {
          ...(file.properties ?? {}),
          branchContext,
          lastSeenPath: change.path,
        },
      });
      this.brain.relations.create({
        type: 'touches_file',
        sourceId: event.id,
        targetId: file.id,
        namespace: payload.namespace,
        properties: { kind: change.kind, mtime: change.mtime, branchContext },
        source,
      });
    }
    return { accepted: true, eventId: event.id };
  }

  handleBranchChange(payload: BranchChangePayload): { branchEntityId: string } {
    this.counters.branch_change_events_total++;
    const actor = payload.author?.canonicalEmail;
    const source: EntitySource = actor
      ? { type: 'git-hook', ref: payload.repo, actor }
      : { type: 'git-hook', ref: payload.repo };

    const toEntity = this.upsertBranchEntity(payload.namespace, payload.to, payload.headSha, actor);
    const fromEntity = this.upsertBranchEntity(payload.namespace, payload.from, undefined, actor);

    this.brain.relations.create({
      type: 'preceded_by',
      sourceId: toEntity.id,
      targetId: fromEntity.id,
      namespace: payload.namespace,
      properties: { at: payload.timestamp ?? this.now() },
      source,
    });

    return { branchEntityId: toEntity.id };
  }

  handleGitEvent(payload: GitEventPayload): { eventId: string } {
    this.counters.git_events_total++;
    const actor = payload.author?.canonicalEmail;
    const source: EntitySource = actor
      ? { type: 'git-hook', ref: payload.repo, actor }
      : { type: 'git-hook', ref: payload.repo };

    const branchContext: BranchContext = {
      branch: payload.branch,
      status: 'wip',
      mrIid: null,
      mergedAt: null,
    };
    const branchEntity = this.upsertBranchEntity(
      payload.namespace,
      payload.branch,
      payload.headSha,
      actor,
    );

    const event = this.brain.entities.create({
      type: 'event',
      name: `git-${payload.kind}:${payload.headSha.slice(0, 8)}`,
      namespace: payload.namespace,
      observations: payload.message ? [payload.message] : [],
      properties: {
        branchContext,
        headSha: payload.headSha,
        kind: payload.kind,
        repo: payload.repo,
        at: payload.timestamp ?? this.now(),
      },
      tags: [`git-${payload.kind}`, `branch:${payload.branch}`],
      source,
    });
    this.brain.relations.create({
      type: 'relates_to',
      sourceId: event.id,
      targetId: branchEntity.id,
      namespace: payload.namespace,
      properties: { branchContext },
      source,
    });
    return { eventId: event.id };
  }

  private upsertBranchEntity(
    ns: string,
    name: string,
    headSha?: string,
    actor?: string,
  ): Entity {
    const matches = this.brain.entities.findByName(name, ns);
    const existing = matches.find((e) => e.type === 'branch' && e.name === name);
    const source: EntitySource = actor
      ? { type: 'git-hook', actor }
      : { type: 'git-hook' };
    if (existing) {
      if (headSha && existing.properties.headSha !== headSha) {
        return (
          this.brain.entities.update(existing.id, {
            properties: { ...(existing.properties ?? {}), headSha },
          }) ?? existing
        );
      }
      return existing;
    }
    return this.brain.entities.create({
      type: 'branch',
      name,
      namespace: ns,
      observations: [],
      properties: headSha ? { headSha } : {},
      tags: ['branch'],
      source,
    });
  }
}

function buildToolObservations(payload: ToolUsePayload): string[] {
  const out: string[] = [];
  out.push(`tool=${payload.toolName} phase=${payload.phase}`);
  if (payload.durationMs !== undefined) out.push(`duration=${payload.durationMs}ms`);
  if (payload.filePaths?.length) out.push(`files=${payload.filePaths.join(',')}`);
  return out;
}
