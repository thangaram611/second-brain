/**
 * Provider abstraction for forge-driven MR/PR ingestion (Phase 10.3).
 *
 * A `GitProvider` wraps the *live webhook + backfill* half of forge
 * ingestion. It's deliberately orthogonal to `Collector` (the batch
 * `pollEvents+emit` shape used by `GitHubCollector`)
 * — those stay around for offline bulk imports; this interface handles
 * per-event streaming.
 *
 * The interface is locked now so the Phase 10.5 GitHub implementation
 * doesn't force a retrofit:
 *
 *   — `ProviderEvent` carries `rawHeaders` so GitHub's
 *     `X-GitHub-Event` header can discriminate, while GitLab's
 *     `object_kind` lives inside the body.
 *   — `RegisterWebhookInput.secret` is a discriminated union of
 *     `{ kind: 'token' }` (GitLab plaintext token compare) and
 *     `{ kind: 'hmac' }` (GitHub HMAC-SHA256 via `X-Hub-Signature-256`)
 *     so the same call site works for both.
 *   — `mapEvent` is pure — no DB, no network. All mutation happens
 *     in `ObservationService.handleMREvent` against `MappedObservation[]`.
 */

import type { CreateEntityInput, Author, BranchStatusPatch } from '@second-brain/types';
import { z } from 'zod';

// ─── Auth ─────────────────────────────────────────────────────────────────

export interface ProviderAuthConfig {
  baseUrl: string;
  pat: string;
}

export interface ProviderAuth {
  userId: string;
  username: string;
  /** Raw scope list as returned by the forge's "scopes for current token" endpoint. */
  scopes: string[];
}

// ─── Webhook register ─────────────────────────────────────────────────────

export type WebhookSecret =
  | { kind: 'token'; value: string }       // GitLab: sent back as X-Gitlab-Token
  | { kind: 'hmac'; key: string };         // GitHub: computes X-Hub-Signature-256

export interface RegisterWebhookInput {
  provider: 'gitlab' | 'github' | 'custom';
  projectId: string;
  relayUrl: string;
  secret: WebhookSecret;
}

export interface WebhookRegistration {
  webhookId: number;
  /** true iff a hook with the same URL already existed on the forge. */
  alreadyExisted: boolean;
}

export interface UnregisterWebhookInput {
  provider: 'gitlab' | 'github' | 'custom';
  projectId: string;
  webhookId: number;
}

// ─── Events ───────────────────────────────────────────────────────────────

export const ProviderEventSchema = z.object({
  provider: z.enum(['gitlab', 'github', 'custom']),
  rawBody: z.unknown(),
  rawHeaders: z.record(z.string(), z.string()),
  receivedAt: z.string(),
  /** Dedupe key. Per-provider: GitLab uses the `X-Gitlab-Event-UUID`
      header; GitHub uses `X-GitHub-Delivery`. */
  deliveryId: z.string().min(1),
});
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export interface PollEventsInput {
  baseUrl: string;
  pat: string;
  projectId: string;
  since: string;             // ISO-8601
  etag?: string;             // If-None-Match value from the previous poll
}

// ─── Delivery verification ────────────────────────────────────────────────

export interface IncomingWebhookRequest {
  headers: Record<string, string>;
  rawBody: Buffer;
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing-header' | 'mismatch' | 'bad-signature' | 'bad-body' };

// ─── Mapped observations ──────────────────────────────────────────────────

export interface MrRef {
  projectId: string;
  iid: number;
}

export interface TouchesFilePath {
  path: string;
  kind: 'add' | 'change' | 'delete';
}

/**
 * The provider-agnostic output of `mapEvent`. `ObservationService.
 * handleMREvent` dispatches on `kind` and applies each observation idem-
 * potently. The `upsert-mr` variant carries an optional `flip` field so
 * merge/close events collapse into one observation (plan revision #7).
 */
export type MappedObservation =
  | {
      kind: 'upsert-mr';
      entity: CreateEntityInput;                 // name = `${project}!${iid}`, title lives in properties
      author: Author;
      touches: TouchesFilePath[];
      flip?: BranchStatusPatch;                  // set on merge/close only
    }
  | {
      kind: 'mr-comment';
      mrRef: MrRef;
      body: string;
      commentId: number;
      author: Author;
      createdAt: string;
    }
  | {
      kind: 'review';
      mrRef: MrRef;
      state: 'approved' | 'changes_requested';
      author: Author;
      createdAt: string;
    }
  | {
      kind: 'pipeline';
      mrRef: MrRef;
      status: string;                            // 'running' | 'success' | 'failed' | ...
      pipelineId: number;
    };

// ─── Provider interface ───────────────────────────────────────────────────

export interface GitProvider {
  readonly name: 'gitlab' | 'github' | 'custom';
  auth(config: ProviderAuthConfig): Promise<ProviderAuth>;
  registerWebhook(input: RegisterWebhookInput): Promise<WebhookRegistration>;
  unregisterWebhook(input: UnregisterWebhookInput): Promise<void>;
  pollEvents(input: PollEventsInput): Promise<{
    events: ProviderEvent[];
    nextEtag?: string;
    cursor: string;  // the max updated_at seen, for next call's `since`
  }>;
  /**
   * Pure: accepts a single webhook event, returns zero or more mapped
   * observations. MUST NOT touch the DB or network beyond in-memory cache
   * lookups maintained by the provider instance itself.
   */
  mapEvent(event: ProviderEvent): Promise<MappedObservation[]>;
  verifyDelivery(input: {
    request: IncomingWebhookRequest;
    expectedSecret: WebhookSecret;
  }): VerificationResult;
}
