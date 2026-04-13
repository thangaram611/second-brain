import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

export interface SqlitePollerOptions<Row> {
  /** Absolute path to the foreign SQLite DB. */
  dbPath: string;
  /** Parameterized SELECT with a single `?` for the since-value. */
  query: string;
  /**
   * Column in each row that represents "time" (or any monotonic key) for
   * watermark tracking. The value is passed back as the `?` bind parameter.
   */
  sinceColumn: string;
  /**
   * Initial watermark when no persisted value is found. Use `''` for string
   * columns, `0` for numeric.
   */
  initialValue?: string | number;
  /** Per-row handler. Errors are captured, not swallowed. */
  onRows: (rows: Row[]) => void | Promise<void>;
  onError?: (err: unknown) => void;
  /** Poll frequency (ms). Default 10s. */
  intervalMs?: number;
  /** Optional watermark persistence path (JSON map keyed by dbPath + query). */
  persistWatermarkPath?: string;
  /** Retry-on-busy policy. Default 3×500ms exp back-off. */
  busyRetries?: number;
}

export interface SqlitePollerHandle {
  close(): void;
  /** Force a single poll now; resolves when the handler is done. */
  runOnce(): Promise<void>;
  /** Current watermark value (read-only). */
  watermark(): string | number;
}

interface WatermarkMap {
  [key: string]: string | number;
}

function watermarkKey(dbPath: string, query: string): string {
  return `${dbPath}::${query}`;
}

function loadWatermarks(p: string): WatermarkMap {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as WatermarkMap;
  } catch {
    return {};
  }
}

function saveWatermarks(p: string, map: WatermarkMap): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(map, null, 2));
  } catch {
    // ignore
  }
}

function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll a foreign SQLite database in read-only mode. Tracks a watermark per
 * (db, query) pair so we only pick up new/updated rows. Tolerates SQLITE_BUSY
 * (common when the foreign writer is mid-checkpoint) with bounded retries.
 *
 * Opens with `readonly: true, fileMustExist: true` so the foreign DB can never
 * be mutated by accident.
 */
export function createSqlitePoller<Row = Record<string, unknown>>(
  options: SqlitePollerOptions<Row>,
): SqlitePollerHandle {
  const {
    dbPath,
    query,
    sinceColumn,
    onRows,
    initialValue = '',
    intervalMs = 10_000,
    busyRetries = 3,
  } = options;
  const onError = options.onError ?? ((err: unknown) => console.error('[sqlite-poller]', err));

  const wmPath = options.persistWatermarkPath;
  const map: WatermarkMap = wmPath ? loadWatermarks(wmPath) : {};
  const key = watermarkKey(dbPath, query);
  let watermark: string | number = map[key] ?? initialValue;
  let closed = false;

  const runOnce = async (): Promise<void> => {
    if (closed) return;
    if (!fs.existsSync(dbPath)) return;

    for (let attempt = 0; attempt <= busyRetries; attempt++) {
      let db: Database.Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        // Extra guard: reject any statement that would write.
        db.pragma('query_only = ON');
        const rows = db.prepare(query).all(watermark) as Row[];
        if (rows.length > 0) {
          await onRows(rows);
          for (const row of rows) {
            const v = (row as Record<string, unknown>)[sinceColumn];
            if (typeof v === 'string' || typeof v === 'number') {
              if (typeof watermark === 'number') {
                watermark = typeof v === 'number' ? Math.max(watermark, v) : watermark;
              } else {
                watermark = typeof v === 'string' && v > (watermark as string) ? v : watermark;
              }
            }
          }
          if (wmPath) {
            map[key] = watermark;
            saveWatermarks(wmPath, map);
          }
        }
        return;
      } catch (err) {
        if (isBusyError(err) && attempt < busyRetries) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        onError(err);
        return;
      } finally {
        if (db) db.close();
      }
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);

  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
    runOnce,
    watermark: () => watermark,
  };
}
