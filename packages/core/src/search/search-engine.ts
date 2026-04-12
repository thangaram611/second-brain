import { eq, and, sql } from 'drizzle-orm';
import type {
  Entity,
  EntityType,
  SearchOptions,
  SearchResult,
  GraphStats,
} from '@second-brain/types';
import { entities } from '../schema/index.js';
import type { StorageDatabase } from '../storage/index.js';

export class SearchEngine {
  constructor(private storage: StorageDatabase) {}

  /**
   * Full-text search using FTS5 with BM25 ranking.
   */
  search(options: SearchOptions): SearchResult[] {
    const { query, namespace, types, limit = 20, offset = 0, minConfidence = 0 } = options;

    if (!query.trim()) return [];

    // Build FTS5 query — strip FTS5 metacharacters and add prefix matching.
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

    // Use raw SQL for FTS5 query since Drizzle doesn't have native FTS support
    let sqlQuery = `
      SELECT
        e.*,
        bm25(entities_fts) AS rank
      FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
    `;
    const params: unknown[] = [ftsQuery];

    if (namespace) {
      sqlQuery += ` AND e.namespace = ?`;
      params.push(namespace);
    }

    if (types && types.length > 0) {
      sqlQuery += ` AND e.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    if (minConfidence > 0) {
      sqlQuery += ` AND e.confidence >= ?`;
      params.push(minConfidence);
    }

    sqlQuery += ` ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.storage.sqlite.prepare(sqlQuery).all(...params) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => ({
      entity: this.rowToEntity(row),
      score: Math.abs(row.rank as number), // BM25 returns negative scores
      matchChannel: 'fulltext' as const,
    }));
  }

  /**
   * Get graph statistics.
   */
  getStats(namespace?: string): GraphStats {
    const db = this.storage.db;

    // Total entities
    const entityCondition = namespace ? eq(entities.namespace, namespace) : undefined;
    const totalEntities =
      db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(entityCondition)
        .get()?.count ?? 0;

    // Total relations
    const relResult = namespace
      ? this.storage.sqlite
          .prepare('SELECT count(*) as count FROM relations WHERE namespace = ?')
          .get(namespace)
      : this.storage.sqlite.prepare('SELECT count(*) as count FROM relations').get();
    const totalRelations = (relResult as { count: number })?.count ?? 0;

    // Entities by type
    const entityTypeRows = this.storage.sqlite
      .prepare(
        namespace
          ? 'SELECT type, count(*) as count FROM entities WHERE namespace = ? GROUP BY type'
          : 'SELECT type, count(*) as count FROM entities GROUP BY type',
      )
      .all(...(namespace ? [namespace] : [])) as Array<{ type: string; count: number }>;
    const entitiesByType: Record<string, number> = {};
    for (const row of entityTypeRows) entitiesByType[row.type] = row.count;

    // Relations by type
    const relTypeRows = this.storage.sqlite
      .prepare(
        namespace
          ? 'SELECT type, count(*) as count FROM relations WHERE namespace = ? GROUP BY type'
          : 'SELECT type, count(*) as count FROM relations GROUP BY type',
      )
      .all(...(namespace ? [namespace] : [])) as Array<{ type: string; count: number }>;
    const relationsByType: Record<string, number> = {};
    for (const row of relTypeRows) relationsByType[row.type] = row.count;

    // Namespaces
    const nsRows = this.storage.sqlite
      .prepare('SELECT DISTINCT namespace FROM entities')
      .all() as Array<{ namespace: string }>;
    const namespaces = nsRows.map((r) => r.namespace);

    return { totalEntities, totalRelations, entitiesByType, relationsByType, namespaces };
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      id: row.id as string,
      type: row.type as EntityType,
      name: row.name as string,
      namespace: row.namespace as string,
      observations: JSON.parse((row.observations as string) || '[]'),
      properties: JSON.parse((row.properties as string) || '{}'),
      confidence: row.confidence as number,
      eventTime: row.event_time as string,
      ingestTime: row.ingest_time as string,
      lastAccessedAt: (row.last_accessed_at as string) ?? (row.created_at as string),
      accessCount: row.access_count as number,
      source: {
        type: row.source_type as Entity['source']['type'],
        ref: (row.source_ref as string) ?? undefined,
        actor: (row.source_actor as string) ?? undefined,
      },
      tags: JSON.parse((row.tags as string) || '[]'),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
