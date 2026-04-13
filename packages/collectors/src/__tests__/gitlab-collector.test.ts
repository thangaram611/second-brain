import { describe, it, expect, vi } from 'vitest';
import { GitLabCollector } from '../gitlab/gitlab-collector.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeMR(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    iid: 42,
    title: 'Add feature X',
    description: 'Short description',
    state: 'opened',
    author: { username: 'alice', name: 'Alice' },
    web_url: 'https://gitlab.com/acme/repo/-/merge_requests/42',
    merged_at: null,
    labels: ['enhancement'],
    ...overrides,
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    iid: 7,
    title: 'Bug: X is broken',
    description: null,
    state: 'opened',
    author: { username: 'bob' },
    web_url: 'https://gitlab.com/acme/repo/-/issues/7',
    labels: [{ name: 'bug' }],
    ...overrides,
  };
}

function mockFetch(responses: Map<RegExp, Response | (() => Response)>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, resp] of responses) {
      if (pattern.test(url)) return typeof resp === 'function' ? resp() : resp;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const baseConfig = { namespace: 'test-ns', ignorePatterns: [] };

describe('GitLabCollector', () => {
  it('emits reference + person + authored_by for a merge request', async () => {
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse([makeMR()])],
        [/\/issues/, jsonResponse([])],
      ]),
    );

    const collector = new GitLabCollector({ project: 'acme/repo', fetchImpl });
    const result = await collector.collect(baseConfig);

    const mrEntity = result.entities.find((e) => e.tags?.includes('merge-request'));
    expect(mrEntity).toBeDefined();
    expect(mrEntity?.name).toBe('acme/repo!42: Add feature X');
    expect(mrEntity?.properties?.state).toBe('opened');
    expect(mrEntity?.tags).toContain('enhancement');

    const person = result.entities.find((e) => e.type === 'person');
    expect(person?.name).toBe('alice');

    const authored = result.relations.find((r) => r.type === 'authored_by');
    expect(authored?.sourceName).toBe('acme/repo!42: Add feature X');
    expect(authored?.targetName).toBe('alice');
  });

  it('emits a Merge event entity when merged_at is set', async () => {
    const merged = makeMR({ iid: 99, merged_at: '2026-01-02T03:04:05Z' });
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse([merged])],
        [/\/issues/, jsonResponse([])],
      ]),
    );
    const collector = new GitLabCollector({ project: 'acme/repo', fetchImpl });
    const result = await collector.collect(baseConfig);

    const event = result.entities.find((e) => e.type === 'event');
    expect(event?.name).toBe('Merge: acme/repo!99');
    expect(event?.eventTime).toBe('2026-01-02T03:04:05Z');
  });

  it('emits issue references with label tags and deduped authors', async () => {
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse([])],
        [/\/issues/, jsonResponse([makeIssue(), makeIssue({ iid: 8, author: { username: 'bob' } })])],
      ]),
    );
    const collector = new GitLabCollector({ project: 'acme/repo', fetchImpl });
    const result = await collector.collect(baseConfig);

    const issues = result.entities.filter((e) => e.tags?.includes('issue'));
    expect(issues).toHaveLength(2);
    expect(issues[0].tags).toContain('bug');

    const bobs = result.entities.filter((e) => e.type === 'person' && e.name === 'bob');
    expect(bobs).toHaveLength(1);
  });

  it('sends PRIVATE-TOKEN header when a token is provided', async () => {
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse([])],
        [/\/issues/, jsonResponse([])],
      ]),
    );
    const collector = new GitLabCollector({
      project: 'acme/repo',
      token: 'glpat-secret',
      fetchImpl,
    });
    await collector.collect(baseConfig);

    const firstCall = fetchImpl.mock.calls[0];
    const opts = firstCall[1];
    const headers = opts?.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('glpat-secret');
  });

  it('URL-encodes project paths that contain slashes', async () => {
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse([])],
        [/\/issues/, jsonResponse([])],
      ]),
    );
    const collector = new GitLabCollector({ project: 'gitlab-org/subgroup/project', fetchImpl });
    await collector.collect(baseConfig);

    const url = fetchImpl.mock.calls[0][0]?.toString() ?? '';
    expect(url).toContain('gitlab-org%2Fsubgroup%2Fproject');
  });

  it('respects custom baseUrl for self-hosted instances', async () => {
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse([])],
        [/\/issues/, jsonResponse([])],
      ]),
    );
    const collector = new GitLabCollector({
      project: 'acme/repo',
      baseUrl: 'https://gitlab.internal.example.com/api/v4',
      fetchImpl,
    });
    await collector.collect(baseConfig);

    const url = fetchImpl.mock.calls[0][0]?.toString() ?? '';
    expect(url.startsWith('https://gitlab.internal.example.com/api/v4')).toBe(true);
  });

  it('continues silently on an API error reporting via progress callback', async () => {
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse({ message: 'Forbidden' }, 403)],
        [/\/issues/, jsonResponse([])],
      ]),
    );
    const progress: string[] = [];
    const collector = new GitLabCollector({ project: 'acme/repo', fetchImpl });

    const result = await collector.collect({
      ...baseConfig,
      onProgress: (p) => progress.push(p.message),
    });

    expect(progress.some((m) => m.includes('GitLab API error'))).toBe(true);
    // Collection didn't throw — returned an empty extraction from the failed branch.
    expect(result.entities).toEqual([]);
  });

  it('caps MR results at maxMRs', async () => {
    const many = Array.from({ length: 10 }, (_, i) => makeMR({ iid: i + 1 }));
    const fetchImpl = mockFetch(
      new Map([
        [/\/merge_requests/, jsonResponse(many)],
        [/\/issues/, jsonResponse([])],
      ]),
    );
    const collector = new GitLabCollector({ project: 'acme/repo', maxMRs: 3, fetchImpl });
    const result = await collector.collect(baseConfig);

    const mrs = result.entities.filter((e) => e.tags?.includes('merge-request'));
    expect(mrs).toHaveLength(3);
  });
});
