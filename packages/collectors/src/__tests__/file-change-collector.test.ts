import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFileChangeCollector, type FileChangeCollectorHandle } from '../git-context/file-change-collector.js';

let tmpDir: string;
let handle: FileChangeCollectorHandle | null = null;

interface CapturedRequest {
  url: string;
  body: unknown;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'tester@example.com'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

function makeFakeFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    captured.push({ url, body: bodyText ? JSON.parse(bodyText) : null });
    return new Response(JSON.stringify({ accepted: true }), { status: 201 });
  }) as typeof fetch;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fcc-test-'));
  initRepo(tmpDir);
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitUntil<T>(
  predicate: () => T | undefined,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v)) && (typeof v !== 'boolean' || v)) {
      return v;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('waitUntil timeout');
}

describe('startFileChangeCollector', () => {
  it('POSTs a batch with branch + namespace + idempotencyKey on file edit', async () => {
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

    const fileChange = await waitUntil(() =>
      captured.find((c) => c.url.includes('/file-change')),
    );
    const body = fileChange.body as Record<string, unknown>;
    expect(body.repo).toBe(path.resolve(tmpDir));
    expect(body.namespace).toBe('myproj');
    expect(body.branch).toBe('main');
    expect(body.idempotencyKey).toMatch(/^[0-9a-f]{40}$/);
    const changes = body.changes as Array<{ path: string; kind: string }>;
    expect(changes.some((c) => c.path === 'src.ts')).toBe(true);
  });

  it('flushes pending batch and posts /branch-change on branch switch', async () => {
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

    fs.writeFileSync(path.join(tmpDir, 'first.ts'), 'a\n');
    await waitUntil(() => captured.find((c) => c.url.includes('/file-change')));

    git(['checkout', '-q', '-b', 'feature/y'], tmpDir);

    await waitUntil(() => captured.find((c) => c.url.includes('/branch-change')));

    const bc = captured.find((c) => c.url.includes('/branch-change'))!.body as Record<string, unknown>;
    expect(bc.from).toBe('main');
    expect(bc.to).toBe('feature/y');
  });

  it('stamps source.actor via supplied author field', async () => {
    const captured: CapturedRequest[] = [];
    handle = await startFileChangeCollector({
      repoRoot: tmpDir,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      author: { canonicalEmail: 'alice@example.com', displayName: 'Alice' },
      debounceMs: 100,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    fs.writeFileSync(path.join(tmpDir, 'author.ts'), 'x\n');
    const fc = await waitUntil(() => captured.find((c) => c.url.includes('/file-change')));
    const body = fc.body as { author?: { canonicalEmail: string } };
    expect(body.author?.canonicalEmail).toBe('alice@example.com');
  });

  it('ignores denylisted lockfile churn', async () => {
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

    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'noise\n');
    fs.writeFileSync(path.join(tmpDir, 'real.ts'), 'x\n');
    const fc = await waitUntil(() => captured.find((c) => c.url.includes('/file-change')));
    const body = fc.body as { changes: Array<{ path: string }> };
    expect(body.changes.some((c) => c.path === 'real.ts')).toBe(true);
    expect(body.changes.some((c) => c.path === 'pnpm-lock.yaml')).toBe(false);
  });

  it('generates distinct idempotency keys for distinct batches', async () => {
    const captured: CapturedRequest[] = [];
    handle = await startFileChangeCollector({
      repoRoot: tmpDir,
      namespace: 'myproj',
      serverUrl: 'http://localhost:0',
      fetchFn: makeFakeFetch(captured),
      debounceMs: 50,
      stabilityWaitMs: 0,
    });
    await handle.ready();

    fs.writeFileSync(path.join(tmpDir, 'first.ts'), '1\n');
    await waitUntil(() => captured.find((c) => c.url.includes('/file-change')));
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(tmpDir, 'second.ts'), '2\n');
    await waitUntil(() => captured.filter((c) => c.url.includes('/file-change')).length >= 2);

    const fc = captured.filter((c) => c.url.includes('/file-change'));
    const keys = fc.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    const unique = new Set(keys);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});
