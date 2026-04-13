import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Octokit ──
const pullsListMock = vi.fn();
const issuesListForRepoMock = vi.fn();

vi.mock('@octokit/rest', () => {
  class MockOctokit {
    pulls = { list: pullsListMock };
    issues = { listForRepo: issuesListForRepoMock };
  }
  return { Octokit: MockOctokit };
});

const { GitHubCollector } = await import('../github/github-collector.js');

// ── Fixtures ──
function makePR(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Add feature X',
    body: 'Short body',
    state: 'open',
    merged_at: null,
    html_url: 'https://github.com/acme/repo/pull/42',
    user: { login: 'alice' },
    ...overrides,
  };
}

function makeMergedPR(overrides: Record<string, unknown> = {}) {
  return makePR({
    number: 99,
    title: 'Merged PR',
    state: 'closed',
    merged_at: '2025-01-15T10:00:00Z',
    html_url: 'https://github.com/acme/repo/pull/99',
    ...overrides,
  });
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: 'Bug report',
    body: 'Something broke',
    state: 'open',
    html_url: 'https://github.com/acme/repo/issues/10',
    user: { login: 'bob' },
    labels: [{ name: 'bug' }],
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    namespace: 'test-ns',
    ignorePatterns: [],
    ...overrides,
  };
}

beforeEach(() => {
  pullsListMock.mockReset();
  issuesListForRepoMock.mockReset();
  // Default: empty responses
  pullsListMock.mockResolvedValue({ data: [] });
  issuesListForRepoMock.mockResolvedValue({ data: [] });
});

describe('GitHubCollector', () => {
  it('throws on invalid repo format', async () => {
    const collector = new GitHubCollector({ repo: 'bad-repo' });
    await expect(collector.collect(makeConfig())).rejects.toThrow('Invalid repo format');
  });

  it('creates reference + person + authored_by for a PR', async () => {
    pullsListMock.mockResolvedValue({ data: [makePR()] });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    const result = await collector.collect(makeConfig());

    const refs = result.entities.filter((e) => e.type === 'reference');
    const persons = result.entities.filter((e) => e.type === 'person');

    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('acme/repo#42: Add feature X');
    expect(refs[0].tags).toContain('pull-request');

    expect(persons).toHaveLength(1);
    expect(persons[0].name).toBe('alice');

    const authored = result.relations.filter((r) => r.type === 'authored_by');
    expect(authored).toHaveLength(1);
    expect(authored[0].sourceName).toBe('acme/repo#42: Add feature X');
    expect(authored[0].targetName).toBe('alice');
  });

  it('creates an event entity for a merged PR', async () => {
    pullsListMock.mockResolvedValue({ data: [makeMergedPR()] });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    const result = await collector.collect(makeConfig());

    const events = result.entities.filter((e) => e.type === 'event');
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('Merge: acme/repo#99');
    expect(events[0].properties?.mergedAt).toBe('2025-01-15T10:00:00Z');
  });

  it('filters out items with pull_request field from issues', async () => {
    const issue = makeIssue();
    const prAsIssue = makeIssue({
      number: 42,
      title: 'PR masquerading as issue',
      pull_request: { url: 'https://api.github.com/...' },
    });
    issuesListForRepoMock.mockResolvedValue({ data: [issue, prAsIssue] });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    const result = await collector.collect(makeConfig());

    const refs = result.entities.filter((e) => e.type === 'reference');
    // Only the real issue, not the PR-masked one
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toContain('#10');
  });

  it('skips schema-invalid items without crashing', async () => {
    const validPR = makePR();
    // Missing required 'title' field
    const invalidPR = { number: 999, state: 'open', html_url: 'x', user: null };
    pullsListMock.mockResolvedValue({ data: [validPR, invalidPR] });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    const result = await collector.collect(makeConfig());

    const refs = result.entities.filter((e) => e.type === 'reference');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toContain('#42');
  });

  it('uses LLM extractor on long PR bodies and links decisions', async () => {
    const longBody = 'A'.repeat(300);
    pullsListMock.mockResolvedValue({
      data: [makePR({ body: longBody })],
    });

    const mockExtractor = {
      extract: vi.fn().mockResolvedValue({
        entities: [
          {
            type: 'decision' as const,
            name: 'Use Redis',
            namespace: 'test-ns',
            source: { type: 'github' as const },
            observations: [],
            tags: [],
          },
        ],
        relations: [],
      }),
    };

    const collector = new GitHubCollector({
      repo: 'acme/repo',
      token: 'fake',
      extractor: mockExtractor as never,
    });
    const result = await collector.collect(makeConfig());

    expect(mockExtractor.extract).toHaveBeenCalledOnce();
    const decisions = result.entities.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].name).toBe('Use Redis');

    const decidedIn = result.relations.filter((r) => r.type === 'decided_in');
    expect(decidedIn).toHaveLength(1);
    expect(decidedIn[0].sourceName).toBe('Use Redis');
    expect(decidedIn[0].targetName).toBe('acme/repo#42: Add feature X');
  });

  it('does not call extractor when none is provided', async () => {
    const longBody = 'A'.repeat(300);
    pullsListMock.mockResolvedValue({
      data: [makePR({ body: longBody })],
    });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    const result = await collector.collect(makeConfig());

    const decisions = result.entities.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(0);
  });

  it('does not call extractor when body is short', async () => {
    pullsListMock.mockResolvedValue({
      data: [makePR({ body: 'short' })],
    });

    const mockExtractor = { extract: vi.fn() };
    const collector = new GitHubCollector({
      repo: 'acme/repo',
      token: 'fake',
      extractor: mockExtractor as never,
    });
    await collector.collect(makeConfig());

    expect(mockExtractor.extract).not.toHaveBeenCalled();
  });

  it('handles rate-limit errors gracefully via onProgress', async () => {
    const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
    pullsListMock.mockRejectedValue(rateLimitError);

    const progressMessages: string[] = [];
    const config = makeConfig({
      onProgress: (p: { message: string }) => progressMessages.push(p.message),
    });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    // Should NOT throw
    const result = await collector.collect(config);

    expect(result.entities).toHaveLength(0);
    expect(progressMessages.some((m) => m.includes('403'))).toBe(true);
  });

  it('emits progress events for each PR and issue', async () => {
    pullsListMock.mockResolvedValue({ data: [makePR()] });
    issuesListForRepoMock.mockResolvedValue({ data: [makeIssue()] });

    const events: Array<{ message: string }> = [];
    const config = makeConfig({
      onProgress: (p: { message: string }) => events.push(p),
    });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    await collector.collect(config);

    expect(events.some((e) => e.message.includes('PR #42'))).toBe(true);
    expect(events.some((e) => e.message.includes('Issue #10'))).toBe(true);
  });

  it('deduplicates person entities across PRs and issues', async () => {
    pullsListMock.mockResolvedValue({
      data: [makePR({ user: { login: 'alice' } })],
    });
    issuesListForRepoMock.mockResolvedValue({
      data: [makeIssue({ user: { login: 'alice' } })],
    });

    const collector = new GitHubCollector({ repo: 'acme/repo', token: 'fake' });
    const result = await collector.collect(makeConfig());

    const persons = result.entities.filter((e) => e.type === 'person');
    expect(persons).toHaveLength(1);
  });
});
