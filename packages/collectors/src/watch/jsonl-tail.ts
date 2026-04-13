import * as fs from 'node:fs';
import * as path from 'node:path';

export interface JsonlTailOptions {
  /** File to tail. Does not need to exist at startup. */
  filePath: string;
  /** Called per JSON line. Errors are caught and surfaced via onError. */
  onLine: (value: unknown, rawLine: string) => void | Promise<void>;
  /** Optional error sink; defaults to console.error. */
  onError?: (err: unknown) => void;
  /** When true, seek to EOF on first open instead of replaying history. */
  startAtEof?: boolean;
  /**
   * Persist the byte-offset to a JSON file so restarts don't re-ingest.
   * The file is a map from absolute filePath → { offset, mtime, ino }.
   */
  persistOffsetPath?: string;
  /** Polling interval for detecting growth (ms). Default 250. */
  pollIntervalMs?: number;
}

export interface JsonlTailHandle {
  close(): void;
  /** Current byte offset into the file. */
  offset(): number;
}

interface OffsetMap {
  [filePath: string]: { offset: number; mtimeMs: number; ino: number };
}

function loadOffsets(p: string): OffsetMap {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as OffsetMap;
  } catch {
    return {};
  }
}

function saveOffsets(p: string, map: OffsetMap): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(map, null, 2));
  } catch {
    // Ignore persistence errors — next tick will try again.
  }
}

/**
 * Tail a JSONL file, invoking `onLine` per complete line. Handles:
 * - file created after startup
 * - file rotated/truncated (inode change → re-open from 0)
 * - partial trailing line (buffered until newline)
 * - persisted offset so restarts resume where they left off
 *
 * Uses polling (`fs.stat` + `read`) rather than `fs.watch` because chokidar's
 * change events don't expose the new byte range reliably on macOS.
 */
export function createJsonlTail(options: JsonlTailOptions): JsonlTailHandle {
  const { filePath, onLine } = options;
  const onError = options.onError ?? ((err: unknown) => console.error('[jsonl-tail]', err));
  const poll = options.pollIntervalMs ?? 250;

  let offset = 0;
  let inode = 0;
  let buffer = '';
  let closed = false;

  // Restore persisted state (unless startAtEof requested fresh start).
  const map: OffsetMap = options.persistOffsetPath ? loadOffsets(options.persistOffsetPath) : {};
  const persisted = map[filePath];

  const flush = async (chunk: string) => {
    const pieces = chunk.split('\n');
    for (let i = 0; i < pieces.length - 1; i++) {
      const line = (buffer + pieces[i]).trim();
      buffer = '';
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        await onLine(parsed, line);
      } catch (err) {
        onError(err);
      }
    }
    buffer += pieces[pieces.length - 1];
  };

  const persist = () => {
    if (!options.persistOffsetPath) return;
    map[filePath] = { offset, mtimeMs: Date.now(), ino: inode };
    saveOffsets(options.persistOffsetPath, map);
  };

  const tick = async () => {
    if (closed) return;
    try {
      const stat = fs.statSync(filePath);
      if (inode === 0) {
        inode = stat.ino;
        if (persisted && persisted.ino === stat.ino && !options.startAtEof) {
          offset = Math.min(persisted.offset, stat.size);
        } else if (options.startAtEof) {
          offset = stat.size;
        } else {
          offset = 0;
        }
      } else if (stat.ino !== inode) {
        // Rotated — switch to new inode, read from beginning.
        inode = stat.ino;
        offset = 0;
        buffer = '';
      }

      if (stat.size < offset) {
        // Truncated.
        offset = 0;
        buffer = '';
      }

      if (stat.size > offset) {
        const fd = fs.openSync(filePath, 'r');
        try {
          const toRead = Math.min(stat.size - offset, 1_000_000);
          const buf = Buffer.alloc(toRead);
          const read = fs.readSync(fd, buf, 0, toRead, offset);
          offset += read;
          if (read > 0) {
            await flush(buf.slice(0, read).toString('utf8'));
          }
        } finally {
          fs.closeSync(fd);
        }
        persist();
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') onError(err);
      // Otherwise: file doesn't exist yet — retry on next tick.
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, poll);
  // Prime once synchronously via scheduled microtask.
  void tick();

  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
    offset: () => offset,
  };
}
