import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalizeEmail, type Author, type BranchStatusPatch } from '@second-brain/types';
import type {
  GitProvider,
  ProviderAuthConfig,
  ProviderAuth,
  RegisterWebhookInput,
  WebhookRegistration,
  UnregisterWebhookInput,
  PollEventsInput,
  ProviderEvent,
  MappedObservation,
  VerificationResult,
  IncomingWebhookRequest,
  WebhookSecret,
} from './git-provider.js';
import {
  extractField,
  type CustomProviderMapping,
  type PREventMapping,
  type ReviewEventMapping,
  type CommentEventMapping,
} from './custom-provider-types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const needle = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== needle) continue;
    if (Array.isArray(v)) return v[0];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// ─── CustomProvider ───────────────────────────────────────────────────────

export class CustomProvider implements GitProvider {
  readonly name = 'custom' as const;
  private readonly mapping: CustomProviderMapping;

  constructor(mapping: CustomProviderMapping) {
    this.mapping = mapping;
  }

  // ─── Auth (no-op) ──────────────────────────────────────────────────

  async auth(_config: ProviderAuthConfig): Promise<ProviderAuth> {
    return { userId: 'custom', username: this.mapping.name, scopes: [] };
  }

  // ─── Webhook registration (manual) ─────────────────────────────────

  async registerWebhook(_input: RegisterWebhookInput): Promise<WebhookRegistration> {
    console.info(
      `[${this.mapping.name}] Webhook auto-registration is not supported. ` +
      `Please create a webhook manually on your ${this.mapping.name} instance.`,
    );
    return { webhookId: 0, alreadyExisted: false };
  }

  async unregisterWebhook(_input: UnregisterWebhookInput): Promise<void> {
    console.info(
      `[${this.mapping.name}] Webhook auto-removal is not supported. ` +
      `Please remove the webhook manually on your ${this.mapping.name} instance.`,
    );
  }

  // ─── Delivery verification ─────────────────────────────────────────

  verifyDelivery(input: {
    request: IncomingWebhookRequest;
    expectedSecret: WebhookSecret;
  }): VerificationResult {
    const { verification } = this.mapping;

    if (verification.kind === 'token') {
      if (input.expectedSecret.kind !== 'token') {
        return { ok: false, reason: 'bad-signature' };
      }
      const headerValue = pickHeader(input.request.headers, verification.header);
      if (typeof headerValue !== 'string' || headerValue.length === 0) {
        return { ok: false, reason: 'missing-header' };
      }
      const expected = input.expectedSecret.value;
      if (headerValue.length !== expected.length) {
        return { ok: false, reason: 'mismatch' };
      }
      return timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected))
        ? { ok: true }
        : { ok: false, reason: 'mismatch' };
    }

    // HMAC mode
    if (input.expectedSecret.kind !== 'hmac') {
      return { ok: false, reason: 'bad-signature' };
    }
    const sigHeader = pickHeader(input.request.headers, verification.header);
    if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
      return { ok: false, reason: 'missing-header' };
    }
    const computed = createHmac(verification.algorithm, input.expectedSecret.key)
      .update(input.request.rawBody)
      .digest('hex');

    let received = sigHeader;
    if (verification.prefix && received.startsWith(verification.prefix)) {
      received = received.slice(verification.prefix.length);
    }
    if (received.length !== computed.length) {
      return { ok: false, reason: 'mismatch' };
    }
    return timingSafeEqual(Buffer.from(received), Buffer.from(computed))
      ? { ok: true }
      : { ok: false, reason: 'mismatch' };
  }

  // ─── pollEvents (webhook-only, no-op) ──────────────────────────────

  async pollEvents(input: PollEventsInput): Promise<{
    events: ProviderEvent[];
    cursor: string;
  }> {
    return { events: [], cursor: input.since };
  }

  // ─── mapEvent ──────────────────────────────────────────────────────

  async mapEvent(event: ProviderEvent): Promise<MappedObservation[]> {
    const eventType = pickHeader(event.rawHeaders, this.mapping.eventTypeHeader);
    if (!eventType) return [];

    const { mappings } = this.mapping;
    const body = event.rawBody;

    if (eventType === 'pull_request' && mappings.pull_request) {
      return this.mapPullRequest(body, event, mappings.pull_request);
    }
    if (eventType === 'review' && mappings.review) {
      return this.mapReview(body, mappings.review);
    }
    if (eventType === 'comment' && mappings.comment) {
      return this.mapComment(body, mappings.comment);
    }

    return [];
  }

  // ─── PR mapping ────────────────────────────────────────────────────

  private mapPullRequest(
    body: unknown,
    event: ProviderEvent,
    m: PREventMapping,
  ): MappedObservation[] {
    const rawAction = String(extractField(body, m.action) ?? '');
    const prNumber = Number(extractField(body, m.number));
    if (Number.isNaN(prNumber)) return [];

    const action = this.mapping.actionMap?.[rawAction] ?? rawAction;

    const title = String(extractField(body, m.title) ?? '');
    const descRaw = m.body ? extractField(body, m.body) : undefined;
    const description = typeof descRaw === 'string' ? descRaw : null;
    const sourceBranch = String(extractField(body, m.sourceBranch) ?? '');
    const targetBranch = String(extractField(body, m.targetBranch) ?? '');
    const login = String(extractField(body, m.authorLogin) ?? 'unknown');
    const emailRaw = m.authorEmail ? extractField(body, m.authorEmail) : undefined;
    const merged = m.merged ? Boolean(extractField(body, m.merged)) : false;
    const mergedAtRaw = m.mergedAt ? extractField(body, m.mergedAt) : undefined;
    const mergedAt = typeof mergedAtRaw === 'string' && mergedAtRaw.length > 0 ? mergedAtRaw : null;
    const webUrlRaw = m.webUrl ? extractField(body, m.webUrl) : undefined;
    const webUrl = typeof webUrlRaw === 'string' ? webUrlRaw : null;
    const draft = m.draft ? Boolean(extractField(body, m.draft)) : false;

    const projectId = this.resolveProjectId(body);
    const author = this.resolveAuthor(login, typeof emailRaw === 'string' ? emailRaw : undefined);

    let flip: BranchStatusPatch | undefined;
    if (action === 'merge' || (action === 'close' && merged)) {
      flip = {
        status: 'merged',
        mrIid: prNumber,
        mergedAt,
      };
    } else if (action === 'close' && !merged) {
      flip = { status: 'abandoned' };
    }

    const state = action === 'merge'
      ? 'merged'
      : action === 'close'
        ? 'closed'
        : m.state
          ? String(extractField(body, m.state) ?? 'open')
          : 'open';

    return [{
      kind: 'upsert-mr',
      author,
      touches: [],
      flip,
      entity: {
        type: 'merge_request',
        name: `${projectId}#${prNumber}`,
        properties: {
          iid: prNumber,
          projectId,
          title,
          description,
          state,
          sourceBranch,
          targetBranch,
          webUrl,
          mergedAt,
          draft,
        },
        eventTime: event.receivedAt,
        source: {
          type: 'hook',
          ref: webUrl ?? undefined,
          actor: author.canonicalEmail,
        },
        tags: ['merge-request', this.mapping.name, `state:${state}`],
      },
    }];
  }

  // ─── Review mapping ────────────────────────────────────────────────

  private mapReview(body: unknown, m: ReviewEventMapping): MappedObservation[] {
    const rawState = String(extractField(body, m.state) ?? '');
    const prNumber = Number(extractField(body, m.prNumber));
    if (Number.isNaN(prNumber)) return [];

    const login = String(extractField(body, m.authorLogin) ?? 'unknown');
    const createdAt = m.createdAt
      ? String(extractField(body, m.createdAt) ?? new Date().toISOString())
      : new Date().toISOString();

    const mapped = this.mapping.actionMap?.[rawState] ?? rawState;
    const state: 'approved' | 'changes_requested' =
      mapped === 'approve' || mapped === 'approved'
        ? 'approved'
        : 'changes_requested';

    const projectId = this.resolveProjectId(body);
    const author = this.resolveAuthor(login);

    return [{
      kind: 'review',
      mrRef: { projectId, iid: prNumber },
      state,
      author,
      createdAt,
    }];
  }

  // ─── Comment mapping ───────────────────────────────────────────────

  private mapComment(body: unknown, m: CommentEventMapping): MappedObservation[] {
    const commentBody = String(extractField(body, m.body) ?? '');
    const commentId = Number(extractField(body, m.commentId));
    if (Number.isNaN(commentId)) return [];
    const prNumber = Number(extractField(body, m.prNumber));
    if (Number.isNaN(prNumber)) return [];

    const login = String(extractField(body, m.authorLogin) ?? 'unknown');
    const createdAt = m.createdAt
      ? String(extractField(body, m.createdAt) ?? new Date().toISOString())
      : new Date().toISOString();

    const projectId = this.resolveProjectId(body);
    const author = this.resolveAuthor(login);

    return [{
      kind: 'mr-comment',
      mrRef: { projectId, iid: prNumber },
      body: commentBody,
      commentId,
      author,
      createdAt,
    }];
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private resolveProjectId(body: unknown): string {
    const fullName = extractField(body, 'repository.full_name');
    if (typeof fullName === 'string' && fullName.length > 0) return fullName;
    const pathNs = extractField(body, 'project.path_with_namespace');
    if (typeof pathNs === 'string' && pathNs.length > 0) return pathNs;
    return this.mapping.name;
  }

  private resolveAuthor(login: string, email?: string): Author {
    let resolved: string;
    if (email && email.length > 0) {
      resolved = email;
    } else if (this.mapping.noreplyEmailTemplate) {
      resolved = this.mapping.noreplyEmailTemplate.replace('{login}', login);
    } else {
      resolved = `${login}@noreply.custom`;
    }
    return {
      canonicalEmail: canonicalizeEmail(resolved),
      displayName: login,
      aliases: [],
    };
  }
}
