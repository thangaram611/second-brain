import type {
  Entity,
  EntityType,
  DecayEngineConfig,
  DecayRunResult,
  StaleEntityOptions,
} from '@second-brain/types';
import { DECAY_RATES } from '@second-brain/types';
import type { StorageDatabase } from '../storage/index.js';
import { rawRowToEntity } from './row-mappers.js';

const MS_PER_DAY = 86_400_000;
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_THRESHOLD = 0.5;

/** Entity types that never decay (rate === 0) */
const NON_DECAYING_TYPES: EntityType[] = ['person', 'file', 'symbol'];

/**
 * Confidence decay engine — computes effective confidence on-read.
 * The stored `confidence` value is treated as the base confidence.
 * Effective confidence = base * e^(-rate * daysSinceLastAccess)
 */
export class DecayEngine {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private storage: StorageDatabase,
    private config: DecayEngineConfig = {},
  ) {}

  /**
   * Pure function: compute the decayed confidence for an entity.
   * Does not modify the database.
   */
  computeDecayedConfidence(entity: Entity): number {
    const rate = DECAY_RATES[entity.type];
    if (rate === 0) return entity.confidence;

    const lastAccessed = new Date(entity.lastAccessedAt).getTime();
    const daysSinceAccess = (Date.now() - lastAccessed) / MS_PER_DAY;
    if (daysSinceAccess <= 0) return entity.confidence;

    return entity.confidence * Math.exp(-rate * daysSinceAccess);
  }

  /**
   * Find entities whose effective (decayed) confidence falls below the threshold.
   */
  getStaleEntities(options: StaleEntityOptions = {}): (Entity & { effectiveConfidence: number })[] {
    const { threshold = DEFAULT_THRESHOLD, namespace, types, limit = 50, offset = 0 } = options;

    const nonDecaying = NON_DECAYING_TYPES.map(() => '?').join(',');
    let sql = `SELECT * FROM entities WHERE type NOT IN (${nonDecaying}) AND confidence > 0`;
    const params: unknown[] = [...NON_DECAYING_TYPES];

    if (namespace) {
      sql += ` AND namespace = ?`;
      params.push(namespace);
    }

    if (types && types.length > 0) {
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    const rows = this.storage.sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    // Compute effective confidence in JS and filter
    const stale = rows
      .map((row) => {
        const entity = rawRowToEntity(row);
        const effectiveConfidence = this.computeDecayedConfidence(entity);
        return { ...entity, effectiveConfidence };
      })
      .filter((e) => e.effectiveConfidence < threshold)
      .sort((a, b) => a.effectiveConfidence - b.effectiveConfidence);

    // Apply offset + limit after JS filtering
    return stale.slice(offset, offset + limit);
  }

  /**
   * Run one decay analysis pass — counts stale entities without mutating stored values.
   */
  runOnce(): DecayRunResult {
    const start = Date.now();
    const stale = this.getStaleEntities({ threshold: DEFAULT_THRESHOLD, limit: 0 });
    return {
      staleCount: stale.length,
      runDurationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Start the periodic decay check.
   */
  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;

    if (this.config.runImmediately) {
      this.runOnce();
    }

    this.timer = setInterval(() => {
      this.runOnce();
    }, intervalMs);
  }

  /**
   * Stop the periodic decay check.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
