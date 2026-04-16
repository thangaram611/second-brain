import { createHmac, timingSafeEqual } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import {
  canonicalizeEmail,
  githubNoreplyEmail,
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
  GitHubPRWebhookSchema,
  GitHubPRReviewWebhookSchema,
  GitHubPRReviewCommentWebhookSchema,
  GitHubCheckSuiteWebhookSchema,
  GitHubUserRestSchema,
  GitHubHookRestSchema,
  type GitHubPRWebhook,
  type GitHubPRReviewWebhook,
  type GitHubPRReviewCommentWebhook,
  type GitHubCheckSuiteWebhook,
} from './github-webhook-types.js';
import { z } from 'zod';

export interface GitHubProviderOptions {
  /** Base URL — default https://api.github.com. */
  baseUrl?: string;
  /** PAT for this GitHub host. */
  pat?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** User-email cache TTL in ms (default 1h). */
  userCacheTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface CachedUser {
  email: string;
  at: number;
}

const WEBHOOK_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_suite',
] as const;

export class GitHubProvider implements GitProvider {
  readonly name = 'github' as const;

  private baseUrl: string;
  private pat: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly userCache = new Map<string, CachedUser>();
  private readonly userCacheTtlMs: number;
  private readonly now: () => number;

  constructor(opts: GitHubProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.pat = opts.pat ?? process.env.GITHUB_TOKEN;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userCacheTtlMs = opts.userCacheTtlMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  async auth(config: ProviderAuthConfig): Promise<ProviderAuth> {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.pat = config.pat;
    const octokit = this.createOctokit();
    const { data: me } = await octokit.users.getAuthenticated();
    return {
      userId: String(me.id),
      username: me.login,
      // Fine-grained PATs don't expose scopes — return empty.
      scopes: [],
    };
  }

  // ─── Webhook register / unregister (idempotent) ──────────────────────────

  async registerWebhook(input: RegisterWebhookInput): Promise<WebhookRegistration> {
    if (input.secret.kind !== 'hmac') {
      throw new Error('GitHub provider requires secret.kind="hmac"');
    }
    const [owner, repo] = splitOwnerRepo(input.projectId);
    const octokit = this.createOctokit();

    // List existing hooks and check for one with same URL (idempotent).
    const { data: hooks } = await octokit.repos.listWebhooks({ owner, repo });
    const parsed = z.array(GitHubHookRestSchema).parse(hooks);
    const existing = parsed.find((h) => h.config.url === input.relayUrl);
    if (existing) return { webhookId: existing.id, alreadyExisted: true };

    const { data: created } = await octokit.repos.createWebhook({
      owner,
      repo,
      config: {
        url: input.relayUrl,
        secret: input.secret.key,
        content_type: 'json',
      },
      events: [...WEBHOOK_EVENTS],
      active: true,
    });
    return { webhookId: created.id, alreadyExisted: false };
  }

  async unregisterWebhook(input: UnregisterWebhookInput): Promise<void> {
    const [owner, repo] = splitOwnerRepo(input.projectId);
    const octokit = this.createOctokit();
    try {
      await octokit.repos.deleteWebhook({ owner, repo, hook_id: input.webhookId });
    } catch (err: unknown) {
      // 404 is idempotent success (already gone).
      if (isOctokitNotFound(err)) return;
      throw err;
    }
  }

  // ─── pollEvents (ETag-cached) ────────────────────────────────────────────

  async pollEvents(input: PollEventsInput): Promise<{
    events: ProviderEvent[];
    nextEtag?: string;
    cursor: string;
  }> {
    this.baseUrl = input.baseUrl.replace(/\/+$/, '');
    this.pat = input.pat;
    const [owner, repo] = splitOwnerRepo(input.projectId);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      ...(this.pat ? { authorization: `Bearer ${this.pat}` } : {}),
    };
    if (input.etag) headers['if-none-match'] = input.etag;

    const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls?sort=updated&direction=desc&state=all&per_page=100`;
    const res = await this.fetchImpl(url, { headers });

    if (res.status === 304) return { events: [], nextEtag: input.etag, cursor: input.since };
    if (!res.ok) throw this.httpError(res, url);

    const nextEtag = res.headers.get('etag') ?? undefined;
    const rawList: unknown = await res.json();
    if (!Array.isArray(rawList)) throw new Error('GitHub PR list did not return an array');

    const events: ProviderEvent[] = [];
    let cursor = input.since;

    for (const raw of rawList) {
      if (typeof raw !== 'object' || raw === null) continue;
      const obj = raw as Record<string, unknown>;
      const updatedAt = typeof obj.updated_at === 'string' ? obj.updated_at : input.since;
      if (updatedAt <= input.since) continue;
      if (updatedAt > cursor) cursor = updatedAt;

      const number = typeof obj.number === 'number' ? obj.number : null;
      if (number === null) continue;

      // Determine action for backfill synthesis.
      const merged = typeof obj.merged_at === 'string' && obj.merged_at.length > 0;
      const action = merged ? 'closed' : obj.state === 'closed' ? 'closed' : 'synchronize';

      const envelope = {
        action,
        number,
        pull_request: {
          ...obj,
          merged: merged,
          user: obj.user ?? { login: 'unknown' },
          head: obj.head ?? { ref: '' },
          base: obj.base ?? { ref: '' },
        },
      };

      events.push({
        provider: 'github',
        rawBody: envelope,
        rawHeaders: { 'x-github-event': 'pull_request' },
        receivedAt: new Date(this.now()).toISOString(),
        deliveryId: `backfill:${input.projectId}:${number}:${updatedAt}`,
      });
    }
    return { events, nextEtag, cursor };
  }

  // ─── mapEvent (pure, Zod-validated) ──────────────────────────────────────

  async mapEvent(event: ProviderEvent): Promise<MappedObservation[]> {
    const eventType = pickHeader(event.rawHeaders, 'x-github-event');
    if (!eventType) return [];

    switch (eventType) {
      case 'pull_request': {
        const parsed = GitHubPRWebhookSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapPREvent(parsed.data, event);
      }
      case 'pull_request_review': {
        const parsed = GitHubPRReviewWebhookSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapReviewEvent(parsed.data);
      }
      case 'pull_request_review_comment': {
        const parsed = GitHubPRReviewCommentWebhookSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapReviewCommentEvent(parsed.data);
      }
      case 'check_suite': {
        const parsed = GitHubCheckSuiteWebhookSchema.safeParse(event.rawBody);
        if (!parsed.success) return [];
        return this.mapCheckSuiteEvent(parsed.data, event);
      }
      default:
        return [];
    }
  }

  private async mapPREvent(e: GitHubPRWebhook, raw: ProviderEvent): Promise<MappedObservation[]> {
    // Derive owner/repo from the delivery ID or html_url.
    const projectId = this.extractProjectId(raw, e.pull_request.html_url);
    const author = await this.resolveAuthor(e.pull_request.user.login);
    const touches = await this.fetchPrTouches(projectId, e.number);

    let flip: BranchStatusPatch | undefined;
    if (e.action === 'closed' && e.pull_request.merged) {
      flip = {
        status: 'merged',
        mrIid: e.number,
        mergedAt: e.pull_request.merged_at ?? undefined,
      };
    } else if (e.action === 'closed' && !e.pull_request.merged) {
      flip = { status: 'abandoned' };
    }

    const state: string = e.action === 'closed' && e.pull_request.merged
      ? 'merged'
      : e.action === 'closed'
        ? 'closed'
        : e.pull_request.state;

    return [
      {
        kind: 'upsert-mr',
        author,
        touches,
        flip,
        entity: {
          type: 'pull_request',
          name: `${projectId}#${e.number}`,
          properties: {
            iid: e.number,
            projectId,
            title: e.pull_request.title,
            description: e.pull_request.body ?? null,
            state,
            sourceBranch: e.pull_request.head.ref,
            targetBranch: e.pull_request.base.ref,
            webUrl: e.pull_request.html_url ?? null,
            mergedAt: e.pull_request.merged_at ?? null,
            mergeCommitSha: e.pull_request.merge_commit_sha ?? null,
            draft: Boolean(e.pull_request.draft ?? false),
          },
          eventTime: new Date(this.now()).toISOString(),
          source: {
            type: 'github',
            ref: e.pull_request.html_url,
            actor: author.canonicalEmail,
          },
          tags: ['pull-request', 'github', `state:${state}`],
        },
      },
    ];
  }

  private async mapReviewEvent(e: GitHubPRReviewWebhook): Promise<MappedObservation[]> {
    const reviewState = e.review.state.toLowerCase();
    // Skip 'commented' state — too noisy.
    if (reviewState !== 'approved' && reviewState !== 'changes_requested') return [];

    const author = await this.resolveAuthor(e.review.user.login);
    return [
      {
        kind: 'review',
        mrRef: {
          projectId: this.extractProjectIdFromUrl(e.review.html_url),
          iid: e.pull_request.number,
        },
        state: reviewState as 'approved' | 'changes_requested',
        author,
        createdAt: e.review.submitted_at ?? new Date(this.now()).toISOString(),
      },
    ];
  }

  private async mapReviewCommentEvent(e: GitHubPRReviewCommentWebhook): Promise<MappedObservation[]> {
    const author = await this.resolveAuthor(e.comment.user.login);
    return [
      {
        kind: 'mr-comment',
        mrRef: {
          projectId: this.extractProjectIdFromUrl(undefined),
          iid: e.pull_request.number,
        },
        body: e.comment.body,
        commentId: e.comment.id,
        author,
        createdAt: e.comment.created_at,
      },
    ];
  }

  private mapCheckSuiteEvent(e: GitHubCheckSuiteWebhook, raw: ProviderEvent): MappedObservation[] {
    if (e.check_suite.pull_requests.length === 0) return [];
    const firstPR = e.check_suite.pull_requests[0];
    const projectId = this.extractProjectId(raw, undefined);
    return [
      {
        kind: 'pipeline',
        mrRef: {
          projectId,
          iid: firstPR.number,
        },
        status: e.check_suite.conclusion ?? 'unknown',
        pipelineId: e.check_suite.id,
      },
    ];
  }

  private async fetchPrTouches(projectId: string, number: number): Promise<TouchesFilePath[]> {
    if (!this.pat) return [];
    try {
      const [owner, repo] = splitOwnerRepo(projectId);
      const octokit = this.createOctokit();
      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 });
      return files.map((f) => ({
        path: f.filename,
        kind: f.status === 'removed' ? 'delete' as const : f.status === 'added' ? 'add' as const : 'change' as const,
      }));
    } catch {
      return [];
    }
  }

  // ─── verifyDelivery ──────────────────────────────────────────────────────

  verifyDelivery(input: {
    request: IncomingWebhookRequest;
    expectedSecret: WebhookSecret;
  }): VerificationResult {
    if (input.expectedSecret.kind !== 'hmac') return { ok: false, reason: 'bad-signature' };
    const headerValue = pickHeader(input.request.headers, 'x-hub-signature-256');
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return { ok: false, reason: 'missing-header' };
    }
    const expected =
      'sha256=' +
      createHmac('sha256', input.expectedSecret.key)
        .update(input.request.rawBody)
        .digest('hex');
    // Length check first: `timingSafeEqual` throws on unequal length.
    if (headerValue.length !== expected.length) return { ok: false, reason: 'mismatch' };
    const a = Buffer.from(headerValue);
    const b = Buffer.from(expected);
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
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
      if (!this.pat) return githubNoreplyEmail(0, username);
      const octokit = this.createOctokit();
      const { data: user } = await octokit.users.getByUsername({ username });
      const parsed = GitHubUserRestSchema.parse(user);
      return parsed.email ?? githubNoreplyEmail(parsed.id, username);
    } catch {
      return githubNoreplyEmail(0, username);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private createOctokit(): Octokit {
    return new Octokit({
      auth: this.pat,
      baseUrl: this.baseUrl === 'https://api.github.com' ? undefined : this.baseUrl,
      request: { fetch: this.fetchImpl },
    });
  }

  /** Extract `owner/repo` from a delivery ID like `backfill:owner/repo:42:ts`
      or from an html_url like `https://github.com/owner/repo/pull/42`. */
  private extractProjectId(event: ProviderEvent, htmlUrl: string | undefined): string {
    // Try delivery ID first (backfill pattern).
    if (event.deliveryId.startsWith('backfill:')) {
      const parts = event.deliveryId.split(':');
      if (parts.length >= 3) return parts[1];
    }
    return this.extractProjectIdFromUrl(htmlUrl);
  }

  private extractProjectIdFromUrl(url: string | undefined): string {
    if (!url) return 'unknown/unknown';
    const m = url.match(/github\.com\/([^/]+\/[^/]+)/);
    return m ? m[1] : 'unknown/unknown';
  }

  private httpError(res: Response, ctx: string): Error {
    const err = new Error(`GitHub API ${res.status} ${res.statusText} for ${ctx}`);
    (err as Error & { status: number }).status = res.status;
    return err;
  }
}

// ─── Module-level helpers ──────────────────────────────────────────────────

function splitOwnerRepo(projectId: string): [string, string] {
  const idx = projectId.indexOf('/');
  if (idx < 0) throw new Error(`Invalid projectId "${projectId}" — expected "owner/repo"`);
  return [projectId.slice(0, idx), projectId.slice(idx + 1)];
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

function isOctokitNotFound(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    return (err as { status: number }).status === 404;
  }
  return false;
}
