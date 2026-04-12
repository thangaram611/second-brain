import type {
  Entity,
  SearchResult,
  TemporalQueryOptions,
  TimelineEntry,
  TimelineOptions,
  EntityType,
} from '@second-brain/types';
import type { StorageDatabase } from '../storage/index.js';
import { rawRowToEntity } from './row-mappers.js';

/**
 * Bitemporal query engine — supports "as-of" queries and timeline generation.
 */
export class BitemporalQueries {
  constructor(private storage: StorageDatabase) {}

  /**
   * Query entities as of a specific event time and/or ingest time.
   * - asOfEventTime: "what was true as of this date"
   * - asOfIngestTime: "what did we know as of this date"
   */
  getEntitiesAsOf(options: TemporalQueryOptions): Entity[] {
    const { asOfEventTime, asOfIngestTime, namespace, types, limit = 50, offset = 0 } = options;

    let sql = `SELECT * FROM entities WHERE 1=1`;
    const params: unknown[] = [];

    if (asOfEventTime) {
      sql += ` AND event_time <= ?`;
      params.push(asOfEventTime);
    }

    if (asOfIngestTime) {
      sql += ` AND ingest_time <= ?`;
      params.push(asOfIngestTime);
    }

    if (namespace) {
      sql += ` AND namespace = ?`;
      params.push(namespace);
    }

    if (types && types.length > 0) {
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ` ORDER BY event_time DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.storage.sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rawRowToEntity);
  }

  /**
   * Get a timeline of knowledge changes within a date range.
   * Returns lightweight entries (not full entities) for efficient rendering.
   */
  getTimeline(options: TimelineOptions): TimelineEntry[] {
    const { from, to, namespace, types, limit = 100, offset = 0 } = options;

    // Build WHERE filters shared by both halves of the UNION
    let filters = '';
    const filterParams: unknown[] = [];

    if (namespace) {
      filters += ` AND namespace = ?`;
      filterParams.push(namespace);
    }

    if (types && types.length > 0) {
      filters += ` AND type IN (${types.map(() => '?').join(',')})`;
      filterParams.push(...types);
    }

    const sql = `
      SELECT id, name, type, 'created' AS change_type, created_at AS ts, confidence, namespace
      FROM entities
      WHERE created_at BETWEEN ? AND ?${filters}
      UNION ALL
      SELECT id, name, type, 'updated' AS change_type, updated_at AS ts, confidence, namespace
      FROM entities
      WHERE updated_at BETWEEN ? AND ? AND updated_at != created_at${filters}
      ORDER BY ts DESC
      LIMIT ? OFFSET ?
    `;

    const params = [from, to, ...filterParams, from, to, ...filterParams, limit, offset];
    const rows = this.storage.sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      entityId: row.id as string,
      entityName: row.name as string,
      entityType: row.type as EntityType,
      changeType: row.change_type as 'created' | 'updated',
      timestamp: row.ts as string,
      confidence: row.confidence as number,
      namespace: row.namespace as string,
    }));
  }

  /**
   * Combine FTS5 search with bitemporal filters.
   * Extends the SearchEngine FTS5 pattern with temporal WHERE clauses.
   */
  searchAsOf(query: string, options: TemporalQueryOptions): SearchResult[] {
    const { asOfEventTime, asOfIngestTime, namespace, types, limit = 20, offset = 0 } = options;

    if (!query.trim()) return [];

    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .map((term) => {
        const sanitized = term.replace(/['"()*^~{}[\]:]/g, '');
        if (!sanitized) return null;
        return `"${sanitized}"*`;
      })
      .filter(Boolean)
      .join(' ');

    if (!ftsQuery) return [];

    let sql = `
      SELECT e.*, bm25(entities_fts) AS rank
      FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
    `;
    const params: unknown[] = [ftsQuery];

    if (asOfEventTime) {
      sql += ` AND e.event_time <= ?`;
      params.push(asOfEventTime);
    }

    if (asOfIngestTime) {
      sql += ` AND e.ingest_time <= ?`;
      params.push(asOfIngestTime);
    }

    if (namespace) {
      sql += ` AND e.namespace = ?`;
      params.push(namespace);
    }

    if (types && types.length > 0) {
      sql += ` AND e.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.storage.sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      entity: rawRowToEntity(row),
      score: Math.abs(row.rank as number),
      matchChannel: 'fulltext' as const,
    }));
  }
}
