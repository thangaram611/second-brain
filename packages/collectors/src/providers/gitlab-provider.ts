import { timingSafeEqual } from 'node:crypto';
import {
  canonicalizeEmail,
  gitlabNoreplyEmail,
  type Author,
  type BranchStatusPatch,
} from '@second-brain/types';
import {
  type GitProvider,
  type ProviderAuthConfig,
  type ProviderAuth,
  type RegisterWebhookInput,
  type WebhookRegistration,
  type UnregisterWebhookInput,
  type PollEventsInput,
  type ProviderEvent,
  type MappedObservation,
  type VerificationResult,
  type IncomingWebhookRequest,
  type WebhookSecret,
  type TouchesFilePath,
} from './git-provider.js';
import {
  GitLabWebhookEventSchema,
  GitLabMREventSchema,
  GitLabMRNoteEventSchema,
  GitLabPipelineEventSchema,
  GitLabUserRestSchema,
  GitLabProjectRestSchema,
  GitLabHookRestSchema,
  GitLabMRChangesResponseSchema,
  type GitLabMREvent,
  type GitLabMRNoteEvent,
  type GitLabPipelineEvent,
} from './gitlab-webhook-types.js';
import { z } from 'zod';

export interface GitLabProviderOptions {
  /** Base URL ending in /api/v4 — e.g. 'https://git.csez.zohocorpin.com/api/v4'. */
  baseUrl?: string;
  /** PAT for this GitLab host. */
  pat?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** User-email cache TTL in ms (default 1h). */
  userCacheTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface CachedUser { email: string; at: number }

export class GitLabProvider implements GitProvider {
  readonly name = 'gitlab' as const;

  private baseUrl: string;
  private pat: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly userCache = new Map<string, CachedUser>();
  private readonly userCacheTtlMs: number;
  private readonly now: () => number;

  constructor(opts: GitLabProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? 'https://gitlab.com/api/v4');
    this.pat = opts.pat ?? process.env.GITLAB_TOKEN;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userCacheTtlMs = opts.userCacheTtlMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  async auth(config: ProviderAuthConfig): Promise<ProviderAuth> {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.pat = config.pat;
    const [me, tokenInfo] = await Promise.all([
      this.fetchJson(`/user`, GitLabUserRestSchema),
      this.fetchJson(`/personal_access_tokens/self`, TokenSelfSchema).catch(() => null),
    ]);
    return {
      userId: String(me.id),
      username: me.username,
      scopes: tokenInfo?.scopes ?? [],
    };
  }

  // ─── Webhook register / unregister (idempotent, rev #5) ──────────────────

  async registerWebhook(input: RegisterWebhookInput): Promise<WebhookRegistration> {
    if (input.secret.kind !== 'token') {
      throw new Error('GitLab provider requires secret.kind="token"');
    }
    const list = await this.fetchJson(
      `/projects/${encodeURIComponent(input.projectId)}/hooks`,
      z.array(GitLabHookRestSchema),
    );
    const existing = list.find((h) => h.url === input.relayUrl);
    if (existing) return { webhookId: existing.id, alreadyExisted: true };

    const res = await this.req(
      `/projects/${encodeURIComponent(input.projectId)}/hooks`,
      {
        method: 'POST',
        body: JSON.stringify({
          url: input.relayUrl,
          token: input.secret.value,
          merge_requests_events: true,
          note_events: true,
          pipeline_events: true,
          push_events: false,
          enable_ssl_verification: true,
        }),
      },
    );
    const json = await res.json();
    const parsed = GitLabHookRestSchema.parse(json);
    return { webhookId: parsed.id, alreadyExisted: false };
  }

  async unregisterWebhook(input: UnregisterWebhookInput): Promise<void> {
    const url = `/projects/${encodeURIComponent(input.projectId)}/hooks/${input.webhookId}`;
    const res = await this.req(url, { method: 'DELETE' });
    // 404 is idempotent success (already gone) — let callers treat it that way.
    if (res.status === 404) return;
    if (!res.ok) throw this.httpError(res, `unregisterWebhook ${url}`);
  }

  // ─── pollEvents (ETag-cached) ────────────────────────────────────────────

  async pollEvents(input: PollEventsInput): Promise<{
    events: ProviderEvent[];
    nextEtag?: string;
    cursor: string;
  }> {
    this.baseUrl = normalizeBaseUrl(input.baseUrl);
    this.pat = input.pat;
    const qs = new URLSearchParams({
      updated_after: input.since,
      order_by: 'updated_at',
      sort: 'asc',
      per_page: '100',
    });
    const url = `/projects/${encodeURIComponent(input.projectId)}/merge_requests?${qs}`;
    const headers: Record<string, string> = { ...this.authHeaders(), accept: 'application/json' };
    if (input.etag) headers['if-none-match'] = input.etag;
    const res = await this.fetchImpl(this.buildUrl(url), { headers });
    if (res.status === 304) return { events: [], nextEtag: input.etag, cursor: input.since };
    if (!res.ok) throw this.httpError(res, url);
    const nextEtag = res.headers.get('etag') ?? undefined;
    const rawList: unknown = await res.json();
    if (!Array.isArray(rawList)) throw new Error('GitLab MR list did not return an array');

    const events: ProviderEvent[] = [];
    let cursor = input.since;
    for (const raw of rawList) {
      // Synthesize a webhook-shaped envelope for each MR so mapEvent can
      // drive backfill through the exact same dispatch as live events.
      if (typeof raw !== 'object' || raw === null) continue;
      const obj = raw as Record<string, unknown>;
      const updatedAt = typeof obj.updated_at === 'string' ? obj.updated_at : input.since;
      if (updatedAt > cursor) cursor = updatedAt;
      const iid = typeof obj.iid === 'number' ? obj.iid : null;
      if (iid === null) continue;

      // Pick an action: merged → 'merge'; closed-unmerged → 'close'; else 'update'.
      let action: GitLabMREvent['object_attributes']['action'];
      if (typeof obj.merged_at === 'string' && obj.merged_at.length > 0) action = 'merge';
      else if (obj.state === 'closed') action = 'close';
      else action = 'update';

      const envelope = {
        object_kind: 'merge_request',
        user: obj.author ?? { username: 'unknown' },
        project: { id: Number(input.projectId) || 0, path_with_namespace: input.projectId },
        object_attributes: { ...obj, action },
      };
      events.push({
        provider: 'gitlab',
        rawBody: envelope,
        rawHeaders: { 'x-gitlab-event': 'Merge Request Hook' },
        receivedAt: new Date(this.now()).toISOString(),
        deliveryId: `backfill:${input.projectId}:${iid}:${updatedAt}`,
      });
    }
    return { events, nextEtag, cursor };
  }

  // ─── mapEvent (pure, Zod-validated) ──────────────────────────────────────

  async mapEvent(event: ProviderEvent): Promise<MappedObservation[]> {
    const envelope = GitLabWebhookEventSchema.safeParse(event.rawBody);
    if (!envelope.success) return [];
    const kind = envelope.data.object_kind;

    switch (kind) {
      case 'merge_request': {
        const parsed = GitLabMREventSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapMREvent(parsed.data);
      }
      case 'note': {
        const parsed = GitLabMRNoteEventSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapNoteEvent(parsed.data);
      }
      case 'pipeline': {
        const parsed = GitLabPipelineEventSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapPipelineEvent(parsed.data);
      }
      default:
        return [];
    }
  }

  private async mapMREvent(e: GitLabMREvent): Promise<MappedObservation[]> {
    const projectId = e.project.path_with_namespace;
    const attrs = e.object_attributes;
    const author = await this.resolveAuthor(e.user.username);
    const touches = await this.fetchMrTouches(projectId, attrs.iid);

    let flip: BranchStatusPatch | undefined;
    if (attrs.action === 'merge' && attrs.merged_at) {
      flip = {
        status: 'merged',
        mrIid: attrs.iid,
        mergedAt: attrs.merged_at,
      };
    } else if (attrs.action === 'close' && !attrs.merged_at) {
      flip = { status: 'abandoned' };
    }

    const state: string = attrs.action === 'merge' ? 'merged'
      : attrs.action === 'close' ? 'closed'
      : attrs.state;

    const observations: MappedObservation[] = [
      {
        kind: 'upsert-mr',
        author,
        touches,
        flip,
        entity: {
          type: 'merge_request',
          name: `${projectId}!${attrs.iid}`,
          properties: {
            iid: attrs.iid,
            projectId,
            title: attrs.title,
            description: attrs.description ?? null,
            state,
            sourceBranch: attrs.source_branch,
            targetBranch: attrs.target_branch,
            webUrl: attrs.web_url ?? attrs.url ?? null,
            mergedAt: attrs.merged_at ?? null,
            mergeCommitSha: attrs.merge_commit_sha ?? null,
            draft: Boolean(attrs.draft ?? attrs.work_in_progress ?? false),
          },
          eventTime: attrs.updated_at,
          source: { type: 'gitlab', ref: attrs.web_url ?? attrs.url, actor: author.canonicalEmail },
          tags: ['merge-request', 'gitlab', `state:${state}`],
        },
      },
    ];
    if (attrs.action === 'approved') {
      observations.push({
        kind: 'review',
        mrRef: { projectId, iid: attrs.iid },
        state: 'approved',
        author,
        createdAt: attrs.updated_at,
      });
    }
    return observations;
  }

  private async mapNoteEvent(e: GitLabMRNoteEvent): Promise<MappedObservation[]> {
    const author = await this.resolveAuthor(e.user.username);
    return [
      {
        kind: 'mr-comment',
        mrRef: {
          projectId: e.project.path_with_namespace,
          iid: e.merge_request.iid,
        },
        body: e.object_attributes.note,
        commentId: e.object_attributes.id,
        author,
        createdAt: e.object_attributes.created_at,
      },
    ];
  }

  private async mapPipelineEvent(e: GitLabPipelineEvent): Promise<MappedObservation[]> {
    if (!e.merge_request) return [];
    return [
      {
        kind: 'pipeline',
        mrRef: {
          projectId: e.project.path_with_namespace,
          iid: e.merge_request.iid,
        },
        status: e.object_attributes.status,
        pipelineId: e.object_attributes.id,
      },
    ];
  }

  private async fetchMrTouches(projectId: string, iid: number): Promise<TouchesFilePath[]> {
    if (!this.pat) return [];
    try {
      const res = await this.fetchJson(
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/changes`,
        GitLabMRChangesResponseSchema,
      );
      return (res.changes ?? []).map((c) => ({
        path: c.new_path,
        kind: c.deleted_file ? 'delete' : c.new_file ? 'add' : 'change',
      }));
    } catch {
      // Don't block the MR upsert on a missing /changes call.
      return [];
    }
  }

  // ─── Author / user cache ─────────────────────────────────────────────────

  private async resolveAuthor(username: string): Promise<Author> {
    const cached = this.userCache.get(username);
    const age = cached ? this.now() - cached.at : Infinity;
    let email: string;
    if (cached && age < this.userCacheTtlMs) {
      email = cached.email;
    } else {
      email = await this.fetchUserEmail(username);
      this.userCache.set(username, { email, at: this.now() });
    }
    return {
      canonicalEmail: canonicalizeEmail(email),
      displayName: username,
      aliases: [],
    };
  }

  private async fetchUserEmail(username: string): Promise<string> {
    try {
      if (!this.pat) return gitlabNoreplyEmail(username);
      const url = `/users?username=${encodeURIComponent(username)}`;
      const list = await this.fetchJson(url, z.array(GitLabUserRestSchema));
      const match = list.find((u) => u.username === username);
      if (!match) return gitlabNoreplyEmail(username);
      return (
        match.public_email ||
        match.commit_email ||
        match.email ||
        gitlabNoreplyEmail(username)
      );
    } catch {
      return gitlabNoreplyEmail(username);
    }
  }

  // ─── verifyDelivery ──────────────────────────────────────────────────────

  verifyDelivery(input: {
    request: IncomingWebhookRequest;
    expectedSecret: WebhookSecret;
  }): VerificationResult {
    if (input.expectedSecret.kind !== 'token') return { ok: false, reason: 'bad-signature' };
    const headerValue = pickHeader(input.request.headers, 'x-gitlab-token');
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return { ok: false, reason: 'missing-header' };
    }
    const expected = input.expectedSecret.value;
    // Length check first: `timingSafeEqual` throws on unequal length.
    // Leaking length is acceptable here — expected length is a public
    // constant (32-byte hex = 64 chars) so no secret is revealed.
    if (headerValue.length !== expected.length) return { ok: false, reason: 'mismatch' };
    const a = Buffer.from(headerValue);
    const b = Buffer.from(expected);
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
  }

  // ─── HTTP plumbing ───────────────────────────────────────────────────────

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(this.buildUrl(path), {
      ...init,
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  private async fetchJson<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
    const res = await this.req(path, { method: 'GET' });
    if (!res.ok) throw this.httpError(res, path);
    const json: unknown = await res.json();
    return schema.parse(json);
  }

  private buildUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private authHeaders(): Record<string, string> {
    return this.pat ? { 'PRIVATE-TOKEN': this.pat } : {};
  }

  private httpError(res: Response, ctx: string): Error {
    const err = new Error(`GitLab API ${res.status} ${res.statusText} for ${ctx}`);
    (err as Error & { status: number }).status = res.status;
    return err;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v4') ? trimmed : `${trimmed}/api/v4`;
}

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

const TokenSelfSchema = z
  .object({
    scopes: z.array(z.string()).default([]),
  })
  .passthrough();

/**
 * Resolve a GitLab project ID from a `group/subgroup/project` path.
 * Exported as a free helper so `brain wire` can call it without needing
 * a full provider instance.
 */
export async function resolveGitLabProject(opts: {
  baseUrl: string;
  pat: string;
  path: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: number; defaultBranch: string | null; webUrl: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const res = await fetchImpl(
    `${baseUrl}/projects/${encodeURIComponent(opts.path)}`,
    { headers: { 'PRIVATE-TOKEN': opts.pat, accept: 'application/json' } },
  );
  if (!res.ok) {
    const err = new Error(`GitLab project lookup ${res.status}: ${opts.path}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  const parsed = GitLabProjectRestSchema.parse(await res.json());
  return {
    id: parsed.id,
    defaultBranch: parsed.default_branch ?? null,
    webUrl: parsed.web_url ?? null,
  };
}
