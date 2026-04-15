import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitLabProvider, resolveGitLabProject, type ProviderEvent } from '../providers/index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const PROJECT_PATH = 'acme/repo';

function baseMREnvelope(overrides: Record<string, unknown> = {}, actionOverrides: Record<string, unknown> = {}): unknown {
  return {
    object_kind: 'merge_request',
    user: { username: 'alice', name: 'Alice' },
    project: { id: 123, path_with_namespace: PROJECT_PATH, web_url: 'https://gitlab.com/acme/repo' },
    object_attributes: {
      id: 9999,
      iid: 42,
      title: 'Add feature',
      description: 'details',
      state: 'opened',
      action: 'open',
      source_branch: 'feat/x',
      target_branch: 'main',
      url: 'https://gitlab.com/acme/repo/-/merge_requests/42',
      web_url: 'https://gitlab.com/acme/repo/-/merge_requests/42',
      created_at: '2026-04-13T10:00:00Z',
      updated_at: '2026-04-13T10:00:00Z',
      ...actionOverrides,
    },
    ...overrides,
  };
}

function makeProviderEvent(body: unknown, deliveryId = 'd1'): ProviderEvent {
  return {
    provider: 'gitlab',
    rawBody: body,
    rawHeaders: { 'x-gitlab-event': 'Merge Request Hook' },
    receivedAt: '2026-04-15T00:00:00.000Z',
    deliveryId,
  };
}

describe('GitLabProvider.mapEvent', () => {
  let provider: GitLabProvider;

  beforeEach(() => {
    // Disable network by providing a fetch that throws unless the test
    // replaces it. mapEvent should short-circuit for its happy paths.
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/changes')) return jsonResponse({ changes: [] });
      if (url.includes('/users?username=')) {
        return jsonResponse([
          { id: 1, username: 'alice', public_email: 'alice@example.com' },
        ]);
      }
      return jsonResponse({}, 404);
    });
    provider = new GitLabProvider({ pat: 'glpat-test', fetchImpl });
  });

  it('maps an open MR event to upsert-mr with no flip', async () => {
    const obs = await provider.mapEvent(makeProviderEvent(baseMREnvelope()));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('upsert-mr');
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip).toBeUndefined();
    expect(obs[0].entity.name).toBe(`${PROJECT_PATH}!42`);
    expect(obs[0].entity.properties?.iid).toBe(42);
    expect(obs[0].entity.properties?.sourceBranch).toBe('feat/x');
    expect(obs[0].author.canonicalEmail).toBe('alice@example.com');
  });

  it('maps update action the same as open (upsert) without flip', async () => {
    const obs = await provider.mapEvent(makeProviderEvent(baseMREnvelope({}, { action: 'update', title: 'Fix: renamed' })));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('upsert-mr');
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip).toBeUndefined();
    expect(obs[0].entity.properties?.title).toBe('Fix: renamed');
    // iid stays the same across edits — stable key (plan rev #2).
    expect(obs[0].entity.properties?.iid).toBe(42);
  });

  it('maps approved action with review observation appended', async () => {
    const obs = await provider.mapEvent(makeProviderEvent(baseMREnvelope({}, { action: 'approved' })));
    expect(obs.map((o) => o.kind)).toEqual(['upsert-mr', 'review']);
    const review = obs.find((o) => o.kind === 'review');
    if (!review || review.kind !== 'review') throw new Error('review obs missing');
    expect(review.state).toBe('approved');
  });

  it('maps merge action with upsert-mr.flip.status=merged', async () => {
    const body = baseMREnvelope({}, {
      action: 'merge',
      state: 'merged',
      merged_at: '2026-04-13T12:00:00Z',
      merge_commit_sha: 'sha-abc',
    });
    const obs = await provider.mapEvent(makeProviderEvent(body));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip?.status).toBe('merged');
    expect(obs[0].flip?.mrIid).toBe(42);
    expect(obs[0].flip?.mergedAt).toBe('2026-04-13T12:00:00Z');
  });

  it('maps close-unmerged action with flip.status=abandoned', async () => {
    const body = baseMREnvelope({}, { action: 'close', state: 'closed' });
    const obs = await provider.mapEvent(makeProviderEvent(body));
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip?.status).toBe('abandoned');
  });

  it('maps a note event on an MR to mr-comment', async () => {
    const body = {
      object_kind: 'note',
      user: { username: 'bob' },
      project: { id: 123, path_with_namespace: PROJECT_PATH },
      object_attributes: {
        id: 555,
        note: 'LGTM',
        noteable_type: 'MergeRequest',
        created_at: '2026-04-13T10:01:00Z',
        updated_at: '2026-04-13T10:01:00Z',
      },
      merge_request: { iid: 42 },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('mr-comment');
    if (obs[0].kind !== 'mr-comment') throw new Error('narrowing');
    expect(obs[0].body).toBe('LGTM');
    expect(obs[0].mrRef).toEqual({ projectId: PROJECT_PATH, iid: 42 });
  });

  it('maps a pipeline event that references an MR', async () => {
    const body = {
      object_kind: 'pipeline',
      project: { id: 123, path_with_namespace: PROJECT_PATH },
      object_attributes: { id: 777, status: 'failed' },
      merge_request: { iid: 42 },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'pipeline') throw new Error('narrowing');
    expect(obs[0].status).toBe('failed');
    expect(obs[0].pipelineId).toBe(777);
  });

  it('returns [] for a pipeline event with no MR linkage', async () => {
    const body = {
      object_kind: 'pipeline',
      project: { id: 123, path_with_namespace: PROJECT_PATH },
      object_attributes: { id: 777, status: 'success' },
    };
    const obs = await provider.mapEvent(makeProviderEvent(body));
    expect(obs).toEqual([]);
  });

  it('returns [] for a malformed payload (missing iid)', async () => {
    const body = baseMREnvelope();
    // Delete required iid via a fresh object.
    const mutated = JSON.parse(JSON.stringify(body));
    delete mutated.object_attributes.iid;
    const obs = await provider.mapEvent(makeProviderEvent(mutated));
    expect(obs).toEqual([]);
  });

  it('returns [] for an unknown object_kind', async () => {
    const obs = await provider.mapEvent(makeProviderEvent({ object_kind: 'wiki_page' }));
    expect(obs).toEqual([]);
  });
});

describe('GitLabProvider.verifyDelivery', () => {
  it('accepts a matching token with constant-time compare', () => {
    const provider = new GitLabProvider();
    const result = provider.verifyDelivery({
      request: {
        headers: { 'X-Gitlab-Token': 'a'.repeat(64) },
        rawBody: Buffer.from(''),
      },
      expectedSecret: { kind: 'token', value: 'a'.repeat(64) },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a mismatched token without throwing on length mismatch', () => {
    const provider = new GitLabProvider();
    const result = provider.verifyDelivery({
      request: { headers: { 'x-gitlab-token': 'short' }, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'token', value: 'a'.repeat(64) },
    });
    if (result.ok) throw new Error('should not be ok');
    expect(result.reason).toBe('mismatch');
  });

  it('rejects when header is missing', () => {
    const provider = new GitLabProvider();
    const result = provider.verifyDelivery({
      request: { headers: {}, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'token', value: 'a'.repeat(64) },
    });
    if (result.ok) throw new Error('should not be ok');
    expect(result.reason).toBe('missing-header');
  });

  it('rejects a hmac-kind expected secret on the gitlab provider', () => {
    const provider = new GitLabProvider();
    const result = provider.verifyDelivery({
      request: { headers: { 'x-hub-signature-256': 'sha256=abc' }, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'hmac', key: 'some-key' },
    });
    if (result.ok) throw new Error('should not be ok');
    expect(result.reason).toBe('bad-signature');
  });
});

describe('GitLabProvider.registerWebhook (idempotent by URL)', () => {
  it('creates a new webhook when none matches the URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/hooks') && !url.match(/\/hooks\/\d/)) {
        // GET list then POST create
        return jsonResponse([]);
      }
      return jsonResponse({ id: 111, url: 'https://smee.io/ch' }, 201);
    });
    // Make POST create return a distinct response: adjust mock to handle method.
    const fetchWithMethods = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/hooks')) return jsonResponse([]);
      if (method === 'POST' && url.includes('/hooks')) {
        return jsonResponse({ id: 111, url: 'https://smee.io/ch' }, 201);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const provider = new GitLabProvider({ pat: 'glpat', fetchImpl: fetchWithMethods });
    const reg = await provider.registerWebhook({
      provider: 'gitlab',
      projectId: '123',
      relayUrl: 'https://smee.io/ch',
      secret: { kind: 'token', value: 'sec' },
    });
    expect(reg.alreadyExisted).toBe(false);
    expect(reg.webhookId).toBe(111);
    expect(fetchImpl).toBeDefined(); // keep lint happy
  });

  it('reuses an existing webhook with the same URL (SIGKILL recovery)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/hooks')) {
        return jsonResponse([
          { id: 42, url: 'https://smee.io/ch', merge_requests_events: true },
        ]);
      }
      throw new Error('should not POST when existing hook matches');
    });
    const provider = new GitLabProvider({ pat: 'glpat', fetchImpl });
    const reg = await provider.registerWebhook({
      provider: 'gitlab',
      projectId: '123',
      relayUrl: 'https://smee.io/ch',
      secret: { kind: 'token', value: 'sec' },
    });
    expect(reg.alreadyExisted).toBe(true);
    expect(reg.webhookId).toBe(42);
  });

  it('unregisterWebhook treats 404 as success (idempotent)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ message: 'not found' }, 404));
    const provider = new GitLabProvider({ pat: 'glpat', fetchImpl });
    await expect(
      provider.unregisterWebhook({ provider: 'gitlab', projectId: '123', webhookId: 99 }),
    ).resolves.toBeUndefined();
  });

  it('unregisterWebhook throws on 401', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ message: 'unauth' }, 401));
    const provider = new GitLabProvider({ pat: 'glpat', fetchImpl });
    await expect(
      provider.unregisterWebhook({ provider: 'gitlab', projectId: '123', webhookId: 99 }),
    ).rejects.toThrow();
  });
});

describe('GitLabProvider.auth', () => {
  it('returns userId/username/scopes on success', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/user')) return jsonResponse({ id: 7, username: 'alice' });
      if (url.includes('/personal_access_tokens/self')) {
        return jsonResponse({ scopes: ['api', 'read_user'] });
      }
      return jsonResponse({}, 404);
    });
    const provider = new GitLabProvider({ fetchImpl });
    const res = await provider.auth({ baseUrl: 'https://gitlab.com', pat: 'glpat' });
    expect(res.userId).toBe('7');
    expect(res.username).toBe('alice');
    expect(res.scopes).toContain('api');
  });

  it('throws on 401 from /user', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ message: 'unauth' }, 401));
    const provider = new GitLabProvider({ fetchImpl });
    await expect(
      provider.auth({ baseUrl: 'https://gitlab.com', pat: 'bad' }),
    ).rejects.toThrow();
  });
});

describe('resolveGitLabProject', () => {
  it('returns project id + default branch from the URL-encoded path endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      expect(url).toContain('acme%2Frepo');
      return jsonResponse({ id: 321, path_with_namespace: 'acme/repo', default_branch: 'main' });
    });
    const res = await resolveGitLabProject({
      baseUrl: 'https://gitlab.com',
      pat: 'glpat',
      path: 'acme/repo',
      fetchImpl,
    });
    expect(res.id).toBe(321);
    expect(res.defaultBranch).toBe('main');
  });
});

describe('GitLabProvider.pollEvents (ETag caching)', () => {
  it('returns an empty list and preserves etag on 304', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 304, headers: { etag: 'abc' } }),
    );
    const provider = new GitLabProvider({ fetchImpl });
    const res = await provider.pollEvents({
      baseUrl: 'https://gitlab.com',
      pat: 'glpat',
      projectId: '123',
      since: '2026-04-13T00:00:00Z',
      etag: 'abc',
    });
    expect(res.events).toHaveLength(0);
    expect(res.nextEtag).toBe('abc');
    expect(res.cursor).toBe('2026-04-13T00:00:00Z');
  });

  it('synthesizes ProviderEvents from the MR list on a 200', async () => {
    const mr = {
      iid: 10,
      title: 'Fix',
      state: 'opened',
      source_branch: 'feat/a',
      target_branch: 'main',
      updated_at: '2026-04-13T12:00:00Z',
      created_at: '2026-04-13T10:00:00Z',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([mr]), {
        status: 200,
        headers: { etag: 'new-etag', 'content-type': 'application/json' },
      }),
    );
    const provider = new GitLabProvider({ fetchImpl });
    const res = await provider.pollEvents({
      baseUrl: 'https://gitlab.com',
      pat: 'glpat',
      projectId: '123',
      since: '2026-04-13T00:00:00Z',
    });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].deliveryId).toContain('backfill:123:10');
    expect(res.cursor).toBe('2026-04-13T12:00:00Z');
    expect(res.nextEtag).toBe('new-etag');
  });
});
