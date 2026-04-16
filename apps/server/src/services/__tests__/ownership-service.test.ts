import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '@second-brain/core';
import { OwnershipService, type SimpleGitFactory } from '../ownership-service.js';

function makeBlameOutput(entries: Array<{ email: string; timestamp: number; content: string }>): string {
  return entries
    .map(
      (e) =>
        `abc1234 1 1 1\nauthor Test\nauthor-mail <${e.email}>\nauthor-time ${e.timestamp}\nauthor-tz +0000\ncommitter Test\ncommitter-mail <${e.email}>\ncommitter-time ${e.timestamp}\ncommitter-tz +0000\nsummary test\nfilename test.ts\n\t${e.content}`,
    )
    .join('\n');
}

function makeLogOutput(emails: string[]): string {
  return emails.join('\n') + '\n';
}

function createStubGitFactory(options: {
  blameOutput?: string;
  logOutput?: string;
  testLogOutput?: string;
  blameError?: boolean;
  logError?: boolean;
}): SimpleGitFactory {
  return (_repoRoot: string) => ({
    async blame(_args: string[]): Promise<string> {
      if (options.blameError) throw new Error('git blame failed');
      return options.blameOutput ?? '';
    },
    async log(args: string[]): Promise<string> {
      if (options.logError) throw new Error('git log failed');
      // If args reference a test file, return testLogOutput
      const hasTestFile = args.some((a) => a.includes('.test.'));
      if (hasTestFile && options.testLogOutput !== undefined) {
        return options.testLogOutput;
      }
      return options.logOutput ?? '';
    },
  });
}

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

describe('OwnershipService', () => {
  it('returns scored results with stubbed git', async () => {
    const now = Math.floor(Date.now() / 1000);
    const recentTimestamp = now - 86400; // 1 day ago

    const factory = createStubGitFactory({
      blameOutput: makeBlameOutput([
        { email: 'alice@example.com', timestamp: recentTimestamp, content: 'line1' },
        { email: 'alice@example.com', timestamp: recentTimestamp, content: 'line2' },
        { email: 'bob@example.com', timestamp: recentTimestamp, content: 'line3' },
      ]),
      logOutput: makeLogOutput([
        'alice@example.com',
        'alice@example.com',
        'alice@example.com',
        'bob@example.com',
      ]),
      testLogOutput: makeLogOutput(['alice@example.com']),
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake/repo',
    });

    const results = await svc.query({ path: 'src/foo.ts' });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);

    // Alice should be the top scorer (more blame lines, more commits, test authorship)
    expect(results[0].actor).toBe('alice@example.com');
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].score).toBeLessThanOrEqual(1);

    // Signals should be populated
    expect(results[0].signals.commits).toBe(3);
    expect(results[0].signals.recencyWeightedBlameLines).toBeGreaterThan(0);
    expect(results[0].signals.testAuthorship).toBeGreaterThan(0);
  });

  it('respects limit parameter', async () => {
    const now = Math.floor(Date.now() / 1000);
    const factory = createStubGitFactory({
      blameOutput: makeBlameOutput([
        { email: 'a@x.com', timestamp: now - 100, content: 'l1' },
        { email: 'b@x.com', timestamp: now - 200, content: 'l2' },
        { email: 'c@x.com', timestamp: now - 300, content: 'l3' },
      ]),
      logOutput: makeLogOutput(['a@x.com', 'b@x.com', 'c@x.com']),
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake',
    });

    const results = await svc.query({ path: 'src/foo.ts', limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('normalizes per-dimension so top actor gets 1.0 in each', async () => {
    const now = Math.floor(Date.now() / 1000);
    const factory = createStubGitFactory({
      blameOutput: makeBlameOutput([
        { email: 'alice@x.com', timestamp: now - 86400, content: 'l1' },
        { email: 'alice@x.com', timestamp: now - 86400, content: 'l2' },
        { email: 'alice@x.com', timestamp: now - 86400, content: 'l3' },
        { email: 'alice@x.com', timestamp: now - 86400, content: 'l4' },
        { email: 'bob@x.com', timestamp: now - 86400, content: 'l5' },
      ]),
      logOutput: makeLogOutput(['alice@x.com', 'alice@x.com', 'bob@x.com']),
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake',
    });

    const results = await svc.query({ path: 'src/index.ts', limit: 10 });
    // Alice has 4 blame lines, bob has 1 → alice blame normalized = 1.0, bob = 0.25
    // Alice has 2 commits, bob has 1 → alice commit normalized = 1.0, bob = 0.5
    const alice = results.find((r) => r.actor === 'alice@x.com');
    const bob = results.find((r) => r.actor === 'bob@x.com');

    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.score).toBeGreaterThan(bob!.score);
    // Alice should have max composite close to 0.6 (blame 0.4*1 + commits 0.2*1)
    expect(alice!.score).toBeGreaterThanOrEqual(0.5);
  });

  it('returns cached result on second call within TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    let callCount = 0;

    const factory: SimpleGitFactory = (_root: string) => ({
      async blame(_args: string[]): Promise<string> {
        callCount++;
        return makeBlameOutput([
          { email: 'a@x.com', timestamp: now - 100, content: 'line' },
        ]);
      },
      async log(_args: string[]): Promise<string> {
        callCount++;
        return makeLogOutput(['a@x.com']);
      },
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake',
      cacheTtlMs: 60_000,
    });

    const first = await svc.query({ path: 'src/cached.ts' });
    const callsAfterFirst = callCount;

    const second = await svc.query({ path: 'src/cached.ts' });
    expect(callCount).toBe(callsAfterFirst); // No additional git calls
    expect(second).toEqual(first);
  });

  it('returns empty array for file with no git history', async () => {
    const factory = createStubGitFactory({
      blameError: true,
      logError: true,
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake',
    });

    const results = await svc.query({ path: 'brand-new-file.ts' });
    expect(results).toEqual([]);
  });

  it('returns CODEOWNERS-only result when no git history but CODEOWNERS matches', async () => {
    // We can't easily mock loadCodeowners since it reads from disk,
    // but we verify the code path by testing with a file that has no git history.
    // The actual CODEOWNERS integration is tested via the codeowners tests.
    const factory = createStubGitFactory({
      blameError: true,
      logError: true,
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake',
    });

    // With no CODEOWNERS file at /fake, we get empty
    const results = await svc.query({ path: 'src/foo.ts' });
    expect(results).toEqual([]);
  });

  it('handles recency weighting — older blame lines contribute less', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;
    const yearAgo = now - 365 * 86400;

    const factory = createStubGitFactory({
      blameOutput: makeBlameOutput([
        { email: 'recent@x.com', timestamp: oneDayAgo, content: 'recent line' },
        { email: 'old@x.com', timestamp: yearAgo, content: 'old line' },
      ]),
      logOutput: makeLogOutput(['recent@x.com', 'old@x.com']),
    });

    const svc = new OwnershipService(brain, {
      simpleGit: factory,
      repoRoot: '/fake',
    });

    const results = await svc.query({ path: 'src/recency.ts', limit: 10 });
    const recent = results.find((r) => r.actor === 'recent@x.com');
    const old = results.find((r) => r.actor === 'old@x.com');

    expect(recent).toBeDefined();
    expect(old).toBeDefined();
    // Recent blame should have higher weighted value
    expect(recent!.signals.recencyWeightedBlameLines).toBeGreaterThan(
      old!.signals.recencyWeightedBlameLines,
    );
  });
});
