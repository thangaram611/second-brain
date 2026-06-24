import type { Brain } from '@second-brain/core';
import type { Author, Entity } from '@second-brain/types';
import type { MappedObservation } from '@second-brain/collectors';
import type { ObservationCounters } from './observation-service.js';
import { upsertFileEntity } from './entity-upsert.js';

export interface MREventPayload {
  provider: 'gitlab' | 'github' | 'custom';
  projectId: string;
  deliveryId: string;
  mapped: MappedObservation[];
  timestamp?: string;
}

/** Result from handleMREvent. */
export interface MREventResult {
  eventId: string | null;
  actions: number;
  namespace: string | null;
}

/**
 * MR/webhook event pipeline. Split out of ObservationService; shares the same
 * mutable ObservationCounters object by reference so /api/observe/counters
 * reflects every mr_events / branch_flips increment from one surface.
 */
export class MrEventService {
  /** wiredRepos mapping — server derives MR-event namespace from this
      (plan revision #3). Keyed by `${provider}:${projectId}`. */
  private wiredProjects: Map<string, string> = new Map();

  /** 24h dedupe cache for webhook deliveries (plan revision, idempotency). */
  private seenWebhookDeliveries: Map<string, number> = new Map();

  constructor(
    private brain: Brain,
    private counters: ObservationCounters,
  ) {}

  // ─── Phase 10.3 — MR event pipeline ────────────────────────────────────

  /**
   * Server-side wiredRepos map (plan rev #3). `brain watch` startup calls
   * this for each entry so the route handler can derive namespace from
   * (provider, projectId) instead of trusting the request body.
   */
  registerWiredProject(
    provider: 'gitlab' | 'github' | 'custom',
    projectId: string,
    namespace: string,
  ): void {
    this.wiredProjects.set(`${provider}:${projectId}`, namespace);
  }

  resolveWiredNamespace(
    provider: 'gitlab' | 'github' | 'custom',
    projectId: string,
  ): string | null {
    return this.wiredProjects.get(`${provider}:${projectId}`) ?? null;
  }

  /**
   * Idempotency: 24h rolling cache keyed on the delivery id. GitLab
   * replays failed webhooks up to 4× over ~24 minutes and the UI "Test"
   * button redelivers on demand; this dedupes both.
   */
  private isDuplicateDelivery(key: string): boolean {
    const now = Date.now();
    const expiry = now - 24 * 60 * 60_000;
    for (const [k, seenAt] of this.seenWebhookDeliveries) {
      if (seenAt < expiry) this.seenWebhookDeliveries.delete(k);
    }
    if (this.seenWebhookDeliveries.has(key)) return true;
    this.seenWebhookDeliveries.set(key, now);
    return false;
  }

  /** Used by the route handler to count 429s from rate-limit middleware. */
  noteMREventRateLimited(): void {
    this.counters.mr_events_rate_limited_total++;
  }

  /**
   * Route entry point. Returns an empty result (eventId=null) for deduped
   * or namespace-less deliveries so the HTTP layer can 201 them without
   * carrying the branching into the route.
   */
  handleMREvent(payload: MREventPayload): MREventResult {
    this.counters.mr_events_total++;

    const dedupeKey = `${payload.provider}:${payload.projectId}:${payload.deliveryId}`;
    if (this.isDuplicateDelivery(dedupeKey)) {
      this.counters.mr_events_deduped++;
      return { eventId: null, actions: 0, namespace: null };
    }

    const namespace = this.resolveWiredNamespace(payload.provider, payload.projectId);
    if (namespace === null) {
      this.counters.mr_events_failed++;
      return { eventId: null, actions: 0, namespace: null };
    }

    if (payload.mapped.length === 0) {
      // Provider couldn't parse this event — not necessarily a failure
      // (e.g., object_kind we don't handle). Record and move on.
      return { eventId: null, actions: 0, namespace };
    }

    const eventEntity = this.brain.entities.create({
      type: 'event',
      name: `mr-event:${payload.deliveryId}`,
      namespace,
      observations: [],
      properties: {
        provider: payload.provider,
        projectId: payload.projectId,
        deliveryId: payload.deliveryId,
        at: payload.timestamp ?? new Date().toISOString(),
      },
      tags: ['mr-event', `provider:${payload.provider}`],
      source: { type: payload.provider === 'gitlab' ? 'gitlab' : 'github', ref: payload.projectId },
    });

    let applied = 0;
    for (const obs of payload.mapped) {
      try {
        switch (obs.kind) {
          case 'upsert-mr':
            this.applyUpsertMR(namespace, obs);
            applied++;
            break;
          case 'mr-comment':
            this.applyMrComment(namespace, obs);
            applied++;
            break;
          case 'review':
            this.applyReview(namespace, obs);
            applied++;
            break;
          case 'pipeline':
            this.applyPipeline(namespace, obs);
            applied++;
            break;
        }
      } catch {
        this.counters.mr_events_failed++;
      }
    }

    return { eventId: eventEntity.id, actions: applied, namespace };
  }

  private upsertMergeRequest(
    namespace: string,
    obs: Extract<MappedObservation, { kind: 'upsert-mr' }>,
  ): Entity {
    const input = obs.entity;
    const iid = input.properties?.iid;
    const projectId = input.properties?.projectId;
    if (typeof iid !== 'number' || typeof projectId !== 'string') {
      // Required for dedup — bail to fresh create.
      return this.brain.entities.create({ ...input, namespace });
    }
    const matches = this.brain.entities.findByTypeAndProperty(
      'merge_request',
      '$.iid',
      iid,
      namespace,
    );
    const existing = matches.find((m) => m.properties?.projectId === projectId);
    if (existing) {
      const merged = {
        ...(existing.properties ?? {}),
        ...(input.properties ?? {}),
      };
      return (
        this.brain.entities.update(existing.id, {
          properties: merged,
          observations: input.observations,
        }) ?? existing
      );
    }
    return this.brain.entities.create({ ...input, namespace });
  }

  private applyUpsertMR(
    namespace: string,
    obs: Extract<MappedObservation, { kind: 'upsert-mr' }>,
  ): void {
    const entity = this.upsertMergeRequest(namespace, obs);
    const authorEntity = this.upsertPersonEntity(namespace, obs.author);
    const actor = obs.author.canonicalEmail;

    this.brain.relations.createOrGet({
      type: 'authored_by',
      sourceId: entity.id,
      targetId: authorEntity.id,
      namespace,
      source: { type: 'gitlab', actor },
    });

    const sourceBranch = typeof entity.properties.sourceBranch === 'string'
      ? entity.properties.sourceBranch
      : undefined;

    for (const touch of obs.touches) {
      const file = upsertFileEntity(this.brain, namespace, touch.path, actor);
      this.brain.relations.createOrGet({
        type: 'touches_file',
        sourceId: entity.id,
        targetId: file.id,
        namespace,
        properties: sourceBranch
          ? {
              kind: touch.kind,
              branchContext: {
                branch: sourceBranch,
                status: 'wip',
                mrIid: null,
                mergedAt: null,
              },
            }
          : { kind: touch.kind },
        source: { type: 'gitlab', actor },
      });
    }

    if (obs.flip && sourceBranch) {
      try {
        const r = this.brain.flipBranchStatus(sourceBranch, obs.flip);
        if (r.updatedEntities > 0 || r.updatedRelations > 0) {
          this.counters.branch_flips_total++;
        }
      } catch {
        this.counters.branch_flips_failed++;
      }
    }
  }

  private applyMrComment(
    namespace: string,
    obs: Extract<MappedObservation, { kind: 'mr-comment' }>,
  ): void {
    const mr = this.findMrEntity(namespace, obs.mrRef.projectId, obs.mrRef.iid);
    if (!mr) return;
    const current = Array.isArray(mr.observations) ? mr.observations : [];
    this.brain.entities.update(mr.id, {
      observations: [...current, `[comment #${obs.commentId} by ${obs.author.displayName ?? obs.author.canonicalEmail}] ${obs.body.slice(0, 500)}`],
    });
  }

  private applyReview(
    namespace: string,
    obs: Extract<MappedObservation, { kind: 'review' }>,
  ): void {
    const mr = this.findMrEntity(namespace, obs.mrRef.projectId, obs.mrRef.iid);
    if (!mr) return;
    const reviewer = this.upsertPersonEntity(namespace, obs.author);
    const reviewName = `review:${obs.mrRef.projectId}!${obs.mrRef.iid}:${obs.author.canonicalEmail}:${obs.createdAt}`;
    const review = this.brain.entities.create({
      type: 'review',
      name: reviewName,
      namespace,
      observations: [],
      properties: { state: obs.state, reviewedAt: obs.createdAt, iid: obs.mrRef.iid, projectId: obs.mrRef.projectId },
      tags: ['review', `state:${obs.state}`],
      source: { type: 'gitlab', actor: obs.author.canonicalEmail },
      eventTime: obs.createdAt,
    });
    this.brain.relations.createOrGet({
      type: 'reviewed_by',
      sourceId: review.id,
      targetId: reviewer.id,
      namespace,
      source: { type: 'gitlab', actor: obs.author.canonicalEmail },
    });
    this.brain.relations.createOrGet({
      type: 'relates_to',
      sourceId: review.id,
      targetId: mr.id,
      namespace,
      source: { type: 'gitlab', actor: obs.author.canonicalEmail },
    });
  }

  private applyPipeline(
    namespace: string,
    obs: Extract<MappedObservation, { kind: 'pipeline' }>,
  ): void {
    const mr = this.findMrEntity(namespace, obs.mrRef.projectId, obs.mrRef.iid);
    if (!mr) return;
    this.brain.entities.update(mr.id, {
      properties: {
        ...(mr.properties ?? {}),
        ci: obs.status,
        ciPipelineId: obs.pipelineId,
      },
    });
  }

  private findMrEntity(namespace: string, projectId: string, iid: number): Entity | null {
    const matches = this.brain.entities.findByTypeAndProperty(
      'merge_request',
      '$.iid',
      iid,
      namespace,
    );
    return matches.find((m) => m.properties?.projectId === projectId) ?? null;
  }

  private upsertPersonEntity(namespace: string, author: Author): Entity {
    const byEmail = this.brain.entities.findByTypeAndProperty(
      'person',
      '$.canonicalEmail',
      author.canonicalEmail,
      namespace,
    );
    if (byEmail[0]) return byEmail[0];
    return this.brain.entities.create({
      type: 'person',
      name: author.displayName ?? author.canonicalEmail,
      namespace,
      observations: [],
      properties: {
        canonicalEmail: author.canonicalEmail,
        displayName: author.displayName ?? null,
        aliases: author.aliases ?? [],
      },
      tags: ['person'],
      source: { type: 'gitlab', actor: author.canonicalEmail },
    });
  }
}
