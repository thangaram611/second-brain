import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitHubProvider, type ProviderEvent } from '../providers/index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const PROJECT_ID = 'acme/repo';

function basePREnvelope(
  overrides: Record<string, unknown> = {},
  prOverrides: Record<string, unknown> = {},
): unknown {
  return {
    action: 'opened',
    number: 42,
    pull_request: {
      title: 'Add feature',
      body: 'details',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: 'feat/x' },
      base: { ref: 'main' },
      html_url: 'https://github.com/acme/repo/pull/42',
      user: { login: 'alice', id: 1 },
      draft: false,
      changed_files: 3,
      ...prOverrides,
    },
    ...overrides,
  };
}

function makeProviderEvent(
  body: unknown,
  eventType: string,
  deliveryId = 'd1',
): ProviderEvent {
  return {
    provider: 'github',
    rawBody: body,
    rawHeaders: { 'x-github-event': eventType },
    receivedAt: '2026-04-15T00:00:00.000Z',
    deliveryId,
  };
}

function computeHmac(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('GitHubProvider.verifyDelivery', () => {
  it('accepts a valid HMAC signature', () => {
    const provider = new GitHubProvider();
    const body = '{"action":"opened"}';
    const secret = 'my-secret';
    const signature = computeHmac(secret, body);
    const result = provider.verifyDelivery({
      request: {
        headers: { 'X-Hub-Signature-256': signature },
        rawBody: Buffer.from(body),
      },
      expectedSecret: { kind: 'hmac', key: secret },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong HMAC signature', () => {
    const provider = new GitHubProvider();
    const body = '{"action":"opened"}';
    const secret = 'my-secret';
    const wrongSig = computeHmac('wrong-secret', body);
    const result = provider.verifyDelivery({
      request: {
        headers: { 'x-hub-signature-256': wrongSig },
        rawBody: Buffer.from(body),
      },
      expectedSecret: { kind: 'hmac', key: secret },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('rejects when x-hub-signature-256 header is missing', () => {
    const provider = new GitHubProvider();
    const result = provider.verifyDelivery({
      request: { headers: {}, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'hmac', key: 'secret' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-header');
  });

  it('rejects when expected secret kind is token (not hmac)', () => {
    const provider = new GitHubProvider();
    const result = provider.verifyDelivery({
      request: { headers: { 'x-hub-signature-256': 'sha256=abc' }, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'token', value: 'some-token' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('handles empty body correctly', () => {
    const provider = new GitHubProvider();
    const body = '';
    const secret = 'my-secret';
    const signature = computeHmac(secret, body);
    const result = provider.verifyDelivery({
      request: {
        headers: { 'x-hub-signature-256': signature },
        rawBody: Buffer.from(body),
      },
      expectedSecret: { kind: 'hmac', key: secret },
    });
    expect(result.ok).toBe(true);
  });
});

describe('GitHubProvider.mapEvent', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/pulls/') && url.includes('/files')) return jsonResponse([]);
      if (url.includes('/users/')) {
        return jsonResponse({ id: 1, login: 'alice', email: 'alice@example.com' });
      }
      return jsonResponse({}, 404);
    });
    provider = new GitHubProvider({ pat: 'ghp_test', fetchImpl });
  });

  it('maps a PR opened event to upsert-mr with no flip', async () => {
    const obs = await provider.mapEvent(makeProviderEvent(basePREnvelope(), 'pull_request'));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('upsert-mr');
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip).toBeUndefined();
    expect(obs[0].entity.name).toBe(`${PROJECT_ID}#42`);
    expect(obs[0].entity.properties?.iid).toBe(42);
    expect(obs[0].entity.properties?.sourceBranch).toBe('feat/x');
    expect(obs[0].author.canonicalEmail).toBe('alice@example.com');
  });

  it('maps a PR closed-merged event with flip.status=merged', async () => {
    const body = basePREnvelope(
      { action: 'closed' },
      { state: 'closed', merged: true, merged_at: '2026-04-13T12:00:00Z', merge_commit_sha: 'sha-abc' },
    );
    const obs = await provider.mapEvent(makeProviderEvent(body, 'pull_request'));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip?.status).toBe('merged');
    expect(obs[0].flip?.mrIid).toBe(42);
    expect(obs[0].flip?.mergedAt).toBe('2026-04-13T12:00:00Z');
  });

  it('maps a PR closed-unmerged event with flip.status=abandoned', async () => {
    const body = basePREnvelope(
      { action: 'closed' },
      { state: 'closed', merged: false },
    );
    const obs = await provider.mapEvent(makeProviderEvent(body, 'pull_request'));
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip?.status).toBe('abandoned');
  });

  it('maps a review approved event', async () => {
    const body = {
      action: 'submitted',
      review: {
        state: 'approved',
        body: 'LGTM',
        user: { login: 'alice', id: 1 },
        submitted_at: '2026-04-13T10:01:00Z',
        html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-1',
      },
      pull_request: { number: 42 },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body, 'pull_request_review'));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('review');
    if (obs[0].kind !== 'review') throw new Error('narrowing');
    expect(obs[0].state).toBe('approved');
  });

  it('maps a review changes_requested event', async () => {
    const body = {
      action: 'submitted',
      review: {
        state: 'changes_requested',
        body: 'Fix this',
        user: { login: 'alice', id: 1 },
        submitted_at: '2026-04-13T10:01:00Z',
        html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-2',
      },
      pull_request: { number: 42 },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body, 'pull_request_review'));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'review') throw new Error('narrowing');
    expect(obs[0].state).toBe('changes_requested');
  });

  it('skips a review with commented state', async () => {
    const body = {
      action: 'submitted',
      review: {
        state: 'commented',
        body: 'Just a comment',
        user: { login: 'alice', id: 1 },
        submitted_at: '2026-04-13T10:01:00Z',
        html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-3',
      },
      pull_request: { number: 42 },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body, 'pull_request_review'));
    expect(obs).toEqual([]);
  });

  it('maps a review comment event to mr-comment', async () => {
    const body = {
      action: 'created',
      comment: {
        id: 555,
        body: 'Nit: rename this',
        user: { login: 'bob', id: 2 },
        created_at: '2026-04-13T10:02:00Z',
        path: 'src/main.ts',
        line: 10,
      },
      pull_request: { number: 42 },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body, 'pull_request_review_comment'));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('mr-comment');
    if (obs[0].kind !== 'mr-comment') throw new Error('narrowing');
    expect(obs[0].body).toBe('Nit: rename this');
    expect(obs[0].commentId).toBe(555);
    expect(obs[0].mrRef.iid).toBe(42);
  });

  it('maps a check_suite completed with linked PRs to pipeline', async () => {
    const body = {
      action: 'completed',
      check_suite: {
        id: 888,
        conclusion: 'success',
        head_branch: 'feat/x',
        pull_requests: [{ number: 42 }],
      },
    };
    const obs = await provider.mapEvent(
      makeProviderEvent(body, 'check_suite', 'backfill:acme/repo:42:2026-04-13T12:00:00Z'),
    );
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'pipeline') throw new Error('narrowing');
    expect(obs[0].status).toBe('success');
    expect(obs[0].pipelineId).toBe(888);
    expect(obs[0].mrRef.iid).toBe(42);
  });

  it('returns [] for check_suite with no linked PRs', async () => {
    const body = {
      action: 'completed',
      check_suite: {
        id: 888,
        conclusion: 'success',
        head_branch: 'feat/x',
        pull_requests: [],
      },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body, 'check_suite'));
    expect(obs).toEqual([]);
  });

  it('returns [] for an unknown event type', async () => {
    const obs = await provider.mapEvent(makeProviderEvent({ something: true }, 'deployment'));
    expect(obs).toEqual([]);
  });
});

describe('GitHubProvider.registerWebhook', () => {
  it('creates a new webhook when none matches the URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      // Octokit uses the same fetch — route by URL pattern.
      if (url.includes('/repos/acme/repo/hooks') && !body) {
        return jsonResponse([]);
      }
      if (url.includes('/repos/acme/repo/hooks') && body) {
        return jsonResponse({ id: 111, config: { url: 'https://smee.io/ch' }, events: ['pull_request'] }, 201);
      }
      throw new Error(`unexpected ${url}`);
    });
    const provider = new GitHubProvider({ pat: 'ghp_test', fetchImpl });
    const reg = await provider.registerWebhook({
      provider: 'github',
      projectId: 'acme/repo',
      relayUrl: 'https://smee.io/ch',
      secret: { kind: 'hmac', key: 'my-secret' },
    });
    expect(reg.alreadyExisted).toBe(false);
    expect(reg.webhookId).toBe(111);
  });

  it('reuses an existing webhook with the same URL (idempotent)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/repos/acme/repo/hooks')) {
        return jsonResponse([
          { id: 42, config: { url: 'https://smee.io/ch' }, events: ['pull_request'] },
        ]);
      }
      throw new Error('should not create when existing hook matches');
    });
    const provider = new GitHubProvider({ pat: 'ghp_test', fetchImpl });
    const reg = await provider.registerWebhook({
      provider: 'github',
      projectId: 'acme/repo',
      relayUrl: 'https://smee.io/ch',
      secret: { kind: 'hmac', key: 'my-secret' },
    });
    expect(reg.alreadyExisted).toBe(true);
    expect(reg.webhookId).toBe(42);
  });
});

describe('GitHubProvider.unregisterWebhook', () => {
  it('succeeds on 204', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const provider = new GitHubProvider({ pat: 'ghp_test', fetchImpl });
    await expect(
      provider.unregisterWebhook({ provider: 'github', projectId: 'acme/repo', webhookId: 99 }),
    ).resolves.toBeUndefined();
  });

  it('treats 404 as idempotent success', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: 'Not Found' }, 404),
    );
    const provider = new GitHubProvider({ pat: 'ghp_test', fetchImpl });
    await expect(
      provider.unregisterWebhook({ provider: 'github', projectId: 'acme/repo', webhookId: 99 }),
    ).resolves.toBeUndefined();
  });
});

describe('GitHubProvider.auth', () => {
  it('returns userId/username/scopes on success', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/user')) return jsonResponse({ id: 7, login: 'alice' });
      return jsonResponse({}, 404);
    });
    const provider = new GitHubProvider({ fetchImpl });
    const res = await provider.auth({ baseUrl: 'https://api.github.com', pat: 'ghp_test' });
    expect(res.userId).toBe('7');
    expect(res.username).toBe('alice');
    expect(res.scopes).toEqual([]);
  });
});

describe('GitHubProvider.pollEvents', () => {
  it('returns an empty list and preserves etag on 304', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 304, headers: { etag: 'abc' } }),
    );
    const provider = new GitHubProvider({ fetchImpl });
    const res = await provider.pollEvents({
      baseUrl: 'https://api.github.com',
      pat: 'ghp_test',
      projectId: 'acme/repo',
      since: '2026-04-13T00:00:00Z',
      etag: 'abc',
    });
    expect(res.events).toHaveLength(0);
    expect(res.nextEtag).toBe('abc');
    expect(res.cursor).toBe('2026-04-13T00:00:00Z');
  });

  it('synthesizes ProviderEvents from the PR list on a 200', async () => {
    const pr = {
      number: 10,
      title: 'Fix',
      state: 'open',
      head: { ref: 'feat/a' },
      base: { ref: 'main' },
      updated_at: '2026-04-13T12:00:00Z',
      created_at: '2026-04-13T10:00:00Z',
      user: { login: 'alice', id: 1 },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([pr]), {
        status: 200,
        headers: { etag: 'new-etag', 'content-type': 'application/json' },
      }),
    );
    const provider = new GitHubProvider({ fetchImpl });
    const res = await provider.pollEvents({
      baseUrl: 'https://api.github.com',
      pat: 'ghp_test',
      projectId: 'acme/repo',
      since: '2026-04-13T00:00:00Z',
    });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].deliveryId).toContain('backfill:acme/repo:10');
    expect(res.cursor).toBe('2026-04-13T12:00:00Z');
    expect(res.nextEtag).toBe('new-etag');
  });
});
