import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  startFileChangeCollector,
  type FileChangeCollectorHandle,
  type WatcherFactory,
  type BranchTrackerFactory,
} from '../git-context/file-change-collector.js';
import type { WatchChange } from '../watch/watcher.js';
import type { BranchChangeEvent } from '../git-context/branch-tracker.js';

// Force chokidar into polling mode for the one real-filesystem smoke test below.
// Native fs events are unreliable under the heavy parallel load of a full
// `pnpm test`; polling re-stats on a fixed interval so detection is
// deterministic. chokidar 4 reads these at watch() time; Vitest's forks pool
// runs each test file in its own process, so this stays scoped to this file.
process.env.CHOKIDAR_USEPOLLING = 'true';
process.env.CHOKIDAR_INTERVAL ??= '25';

interface CapturedRequest {
  url: string;
  body: unknown;
}

// Parse captured POST bodies through Zod rather than `as` casts so the field
// access below is type-checked and the assertions fail loudly on shape drift.
const FileChangeBody = z.object({
  repo: z.string(),
  namespace: z.string(),
  branch: z.string(),
  idempotencyKey: z.string(),
  author: z.object({ canonicalEmail: z.string() }).optional(),
  changes: z.array(z.object({ path: z.string(), kind: z.string() })),
});

const BranchChangeBody = z.object({ from: z.string(), to: z.string() });

function makeFakeFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    captured.push({ url, body: bodyText ? JSON.parse(bodyText) : null });
    return new Response(JSON.stringify({ accepted: true }), { status: 201 });
  }) as typeof fetch;
}

// Fake watcher: captures the collector's onBatch so the test can deliver a
// debounced batch synchronously — no real chokidar, no timing.
function makeFakeWatcher(): {
  factory: WatcherFactory;
  emit(batch: WatchChange[]): Promise<void>;
} {
  let onBatch: ((batch: WatchChange[]) => void | Promise<void>) | null = null;
  return {
    factory: (options) => {
      onBatch = options.onBatch;
      return { ready: Promise.resolve(), close: async () => {} };
    },
    async emit(batch) {
      if (!onBatch) throw new Error('watcher factory not invoked yet');
      await onBatch(batch);
    },
  };
}

// Fake branch tracker: starts on `initialBranch`, lets the test flip branches
// and fire the debounced onBranchChange the collector subscribes to.
function makeFakeTracker(initialBranch: string): {
  factory: BranchTrackerFactory;
  changeBranch(event: BranchChangeEvent): Promise<void>;
} {
  let current = initialBranch;
  let onBranchChange: ((event: BranchChangeEvent) => void | Promise<void>) | null = null;
  return {
    factory: async (options) => {
      onBranchChange = options.onBranchChange;
      return { current: async () => current, close: async () => {} };
    },
    async changeBranch(event) {
      if (!onBranchChange) throw new Error('tracker factory not invoked yet');
      current = event.to;
      await onBranchChange(event);
    },
  };
}

const REPO_ROOT = path.resolve(os.tmpdir(), 'brain-fcc-fake-repo');

describe('startFileChangeCollector (deterministic wiring)', () => {
  let handle: FileChangeCollectorHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it('POSTs a batch with branch + namespace + idempotencyKey on file edit', async () => {
    const captured: CapturedRequest[] = [];
    const watcher = makeFakeWatcher();
    const tracker = makeFakeTracker('main');
    handle = await startFileChangeCollector({
      repoRoot: REPO_ROOT,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      createWatcherImpl: watcher.factory,
      createBranchTrackerImpl: tracker.factory,
      debounceMs: 100,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    await watcher.emit([{ kind: 'add', path: 'src.ts' }]);

    const fileChange = captured.find((c) => c.url.includes('/file-change'));
    expect(fileChange).toBeDefined();
    const body = FileChangeBody.parse(fileChange!.body);
    expect(body.repo).toBe(REPO_ROOT);
    expect(body.namespace).toBe('myproj');
    expect(body.branch).toBe('main');
    expect(body.idempotencyKey).toMatch(/^[0-9a-f]{40}$/);
    expect(body.changes.some((c) => c.path === 'src.ts')).toBe(true);
  });

  it('flushes pending batch and posts /branch-change on branch switch', async () => {
    const captured: CapturedRequest[] = [];
    const watcher = makeFakeWatcher();
    const tracker = makeFakeTracker('main');
    handle = await startFileChangeCollector({
      repoRoot: REPO_ROOT,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      createWatcherImpl: watcher.factory,
      createBranchTrackerImpl: tracker.factory,
      debounceMs: 100,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    await watcher.emit([{ kind: 'add', path: 'first.ts' }]);
    expect(captured.some((c) => c.url.includes('/file-change'))).toBe(true);

    await tracker.changeBranch({
      from: 'main',
      to: 'feature/y',
      headSha: '0123456789abcdef0123456789abcdef01234567',
      at: new Date().toISOString(),
    });

    const branchChange = captured.find((c) => c.url.includes('/branch-change'));
    expect(branchChange).toBeDefined();
    const body = BranchChangeBody.parse(branchChange!.body);
    expect(body.from).toBe('main');
    expect(body.to).toBe('feature/y');
  });

  it('stamps source.actor via supplied author field', async () => {
    const captured: CapturedRequest[] = [];
    const watcher = makeFakeWatcher();
    const tracker = makeFakeTracker('main');
    handle = await startFileChangeCollector({
      repoRoot: REPO_ROOT,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      author: { canonicalEmail: 'alice@example.com', displayName: 'Alice' },
      createWatcherImpl: watcher.factory,
      createBranchTrackerImpl: tracker.factory,
      debounceMs: 100,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    await watcher.emit([{ kind: 'add', path: 'author.ts' }]);

    const fileChange = captured.find((c) => c.url.includes('/file-change'));
    expect(fileChange).toBeDefined();
    const body = FileChangeBody.parse(fileChange!.body);
    expect(body.author?.canonicalEmail).toBe('alice@example.com');
  });

  it('ignores denylisted lockfile churn', async () => {
    const captured: CapturedRequest[] = [];
    const watcher = makeFakeWatcher();
    const tracker = makeFakeTracker('main');
    handle = await startFileChangeCollector({
      repoRoot: REPO_ROOT,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      createWatcherImpl: watcher.factory,
      createBranchTrackerImpl: tracker.factory,
      debounceMs: 100,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    await watcher.emit([
      { kind: 'add', path: 'pnpm-lock.yaml' },
      { kind: 'add', path: 'real.ts' },
    ]);

    const fileChange = captured.find((c) => c.url.includes('/file-change'));
    expect(fileChange).toBeDefined();
    const body = FileChangeBody.parse(fileChange!.body);
    expect(body.changes.some((c) => c.path === 'real.ts')).toBe(true);
    expect(body.changes.some((c) => c.path === 'pnpm-lock.yaml')).toBe(false);
  });

  it('generates distinct idempotency keys for distinct batches', async () => {
    const captured: CapturedRequest[] = [];
    const watcher = makeFakeWatcher();
    const tracker = makeFakeTracker('main');
    handle = await startFileChangeCollector({
      repoRoot: REPO_ROOT,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      createWatcherImpl: watcher.factory,
      createBranchTrackerImpl: tracker.factory,
      debounceMs: 50,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    await watcher.emit([{ kind: 'add', path: 'first.ts' }]);
    await watcher.emit([{ kind: 'add', path: 'second.ts' }]);

    const fileChanges = captured.filter((c) => c.url.includes('/file-change'));
    expect(fileChanges.length).toBeGreaterThanOrEqual(2);
    const keys = fileChanges.map((c) => FileChangeBody.parse(c.body).idempotencyKey);
    expect(new Set(keys).size).toBeGreaterThanOrEqual(2);
  });
});

// One real-chokidar smoke test guarding the *default* wiring (the deterministic
// tests above inject fakes, so they never exercise the real watcher). Real OS
// file events can drop under parallel test load, so this is retry-guarded —
// the same hardening watcher.test.ts uses for its chokidar integration test.
describe('startFileChangeCollector (real watcher smoke)', () => {
  let tmpDir: string;
  let handle: FileChangeCollectorHandle | null = null;

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fcc-test-'));
    git(['init', '-q', '-b', 'main'], tmpDir);
    git(['config', 'user.email', 'tester@example.com'], tmpDir);
    git(['config', 'user.name', 'Tester'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
    git(['add', 'README.md'], tmpDir);
    git(['commit', '-q', '-m', 'init'], tmpDir);
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('posts a /file-change for a real file write through chokidar', { retry: 3, timeout: 20_000 }, async () => {
    const captured: CapturedRequest[] = [];
    handle = await startFileChangeCollector({
      repoRoot: tmpDir,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      debounceMs: 100,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const x = 1;\n');

    const start = Date.now();
    while (Date.now() - start < 15_000 && !captured.some((c) => c.url.includes('/file-change'))) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const fileChange = captured.find((c) => c.url.includes('/file-change'));
    expect(fileChange).toBeDefined();
    const body = FileChangeBody.parse(fileChange!.body);
    expect(body.repo).toBe(path.resolve(tmpDir));
    expect(body.branch).toBe('main');
    expect(body.changes.some((c) => c.path === 'src.ts')).toBe(true);
  });
});
