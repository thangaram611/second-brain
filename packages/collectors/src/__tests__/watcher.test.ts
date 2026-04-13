import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWatcher,
  coalesceBatch,
  type WatchChange,
  type WatcherHandle,
} from '../watch/watcher.js';

let tmpDir: string;
let handle: WatcherHandle | null = null;

function waitFor(predicate: () => boolean, timeoutMs = 10_000, pollMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for predicate'));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-watch-test-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('coalesceBatch (pure)', () => {
  it('drops paired add→unlink of the same file', () => {
    const out = coalesceBatch([
      { kind: 'add', path: '/tmp/a.txt' },
      { kind: 'unlink', path: '/tmp/a.txt' },
    ]);
    expect(out).toEqual([]);
  });

  it('collapses duplicate changes to the last kind (last writer wins)', () => {
    const out = coalesceBatch([
      { kind: 'change', path: '/tmp/a.txt' },
      { kind: 'change', path: '/tmp/a.txt' },
      { kind: 'change', path: '/tmp/a.txt' },
    ]);
    expect(out).toEqual([{ kind: 'change', path: '/tmp/a.txt' }]);
  });

  it('sorts output adds → changes → unlinks', () => {
    const out = coalesceBatch([
      { kind: 'unlink', path: '/tmp/z.txt' },
      { kind: 'change', path: '/tmp/m.txt' },
      { kind: 'add', path: '/tmp/a.txt' },
    ]);
    expect(out.map((c) => c.kind)).toEqual(['add', 'change', 'unlink']);
  });

  it('treats unrelated paths independently', () => {
    const out = coalesceBatch([
      { kind: 'add', path: '/tmp/a.txt' },
      { kind: 'change', path: '/tmp/b.txt' },
      { kind: 'unlink', path: '/tmp/b.txt' },
    ]);
    // a stays as add, b went change→unlink which survives
    expect(out).toEqual([
      { kind: 'add', path: '/tmp/a.txt' },
      { kind: 'unlink', path: '/tmp/b.txt' },
    ]);
  });
});

describe('createWatcher (integration)', () => {
  // fs.watch on macOS occasionally drops events under parallel test load;
  // retries keep CI green without softening the assertion.
  it('observes file additions through chokidar', { retry: 3, timeout: 20_000 }, async () => {
    const batches: WatchChange[][] = [];
    handle = createWatcher({
      roots: [tmpDir],
      debounceMs: 100,
      onBatch: (b) => {
        batches.push(b);
      },
    });
    await handle.ready;

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');

    await waitFor(
      () => {
        const names = batches.flat().map((c) => path.basename(c.path));
        return names.includes('a.txt') && names.includes('b.txt');
      },
      10_000,
    );

    const allKinds = new Set(batches.flat().map((c) => c.kind));
    expect(allKinds.has('add')).toBe(true);
  });

  it('throws when no roots are provided', () => {
    expect(() =>
      createWatcher({
        roots: [],
        onBatch: () => {},
      }),
    ).toThrow(/at least one root/);
  });
});
