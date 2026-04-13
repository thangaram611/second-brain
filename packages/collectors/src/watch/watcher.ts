import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';

export type WatchChangeKind = 'add' | 'change' | 'unlink';

export interface WatchChange {
  kind: WatchChangeKind;
  /** Absolute (or relative-to-cwd) filesystem path as emitted by chokidar. */
  path: string;
}

export interface WatcherOptions {
  /** Directories to watch (recursive). At least one required. */
  roots: readonly string[];
  /** Glob-style ignore patterns forwarded to chokidar. Include node_modules etc. */
  ignored?: (string | RegExp)[];
  /** Debounce window (ms). Changes within the window are coalesced into one batch. Default 500. */
  debounceMs?: number;
  /** Invoked once per debounced batch with unique paths. Batch order: adds, changes, unlinks. */
  onBatch: (batch: WatchChange[]) => void | Promise<void>;
  /** If true, an initial `add` event fires for every pre-existing file (default false — we only care about diffs). */
  ignoreInitial?: boolean;
  /** Error surface — defaults to console.error; override for tests. */
  onError?: (err: unknown) => void;
}

export interface WatcherHandle {
  /** Stop the watcher and flush any pending batch. */
  close(): Promise<void>;
  /** Resolves once chokidar has completed its initial scan. */
  ready: Promise<void>;
  /** Underlying chokidar instance — exposed for advanced use cases. */
  raw: FSWatcher;
}

const DEFAULT_IGNORED = [
  /(^|[/\\])node_modules($|[/\\])/,
  /(^|[/\\])\.git($|[/\\])/,
  /(^|[/\\])\.turbo($|[/\\])/,
  /(^|[/\\])dist($|[/\\])/,
  /(^|[/\\])coverage($|[/\\])/,
];

/**
 * Deterministic batch reducer — pure so it can be unit-tested without hitting
 * the filesystem. Applies the same coalescing rules as the live watcher:
 *   - add followed by unlink for the same path collapses to "no event"
 *   - for everything else, the last event kind wins
 *   - output is ordered: adds → changes → unlinks
 */
export function coalesceBatch(events: ReadonlyArray<WatchChange>): WatchChange[] {
  const pending = new Map<string, WatchChangeKind>();
  for (const ev of events) {
    const existing = pending.get(ev.path);
    if (ev.kind === 'unlink' && existing === 'add') {
      pending.delete(ev.path);
    } else {
      pending.set(ev.path, ev.kind);
    }
  }
  const weight: Record<WatchChangeKind, number> = { add: 0, change: 1, unlink: 2 };
  return [...pending.entries()]
    .map(([path, kind]) => ({ path, kind }))
    .sort((a, b) => weight[a.kind] - weight[b.kind]);
}

/**
 * Watch one or more roots and invoke onBatch with deduplicated changes per
 * debounce window. Order within a batch is stable: adds first, then changes,
 * then unlinks — so a downstream pipeline can process in a sensible order.
 */
export function createWatcher(options: WatcherOptions): WatcherHandle {
  if (options.roots.length === 0) throw new Error('createWatcher requires at least one root');
  const debounceMs = options.debounceMs ?? 500;
  const ignored = options.ignored ?? DEFAULT_IGNORED;
  const ignoreInitial = options.ignoreInitial ?? true;
  const onError = options.onError ?? ((err) => console.error('[watcher]', err));

  const pending: Map<string, WatchChangeKind> = new Map();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerun = false;

  const flush = async (): Promise<void> => {
    if (pending.size === 0) return;
    if (running) {
      rerun = true;
      return;
    }
    const snapshot = [...pending.entries()].map(([path, kind]) => ({ path, kind }));
    pending.clear();
    running = true;
    try {
      // Stable ordering: adds → changes → unlinks
      const weight: Record<WatchChangeKind, number> = { add: 0, change: 1, unlink: 2 };
      snapshot.sort((a, b) => weight[a.kind] - weight[b.kind]);
      await options.onBatch(snapshot);
    } catch (err) {
      onError(err);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  const record = (kind: WatchChangeKind, path: string): void => {
    // Collapse rapid add→change→unlink for a single file: last one wins, except
    // an unlink after an add within the same batch means the file never stuck,
    // so drop both.
    const existing = pending.get(path);
    if (kind === 'unlink' && existing === 'add') {
      pending.delete(path);
    } else {
      pending.set(path, kind);
    }
    schedule();
  };

  const watcher = chokidar.watch([...options.roots], {
    ignored,
    ignoreInitial,
    persistent: true,
  });

  watcher.on('add', (path) => record('add', path));
  watcher.on('change', (path) => record('change', path));
  watcher.on('unlink', (path) => record('unlink', path));
  watcher.on('error', (err) => onError(err));

  const ready = new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });

  return {
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
      await watcher.close();
    },
    ready,
    raw: watcher,
  };
}
