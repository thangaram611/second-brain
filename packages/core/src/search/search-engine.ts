import { eq, and, sql } from 'drizzle-orm';
import type {
  SearchOptions,
  SearchResult,
  GraphStats,
} from '@second-brain/types';
import { entities } from '../schema/index.js';
import type { StorageDatabase } from '../storage/index.js';
import { rawRowToEntity } from '../temporal/row-mappers.js';
import { sanitizeFtsQuery } from './fts-utils.js';
import { reciprocalRankFusion, type RankedResult } from './fusion.js';
import { fulltextToRanked, type VectorSearchChannel } from './vector-channel.js';

export class SearchEngine {
  /** Optional vector search channel. Set via `setVectorChannel()`. */
  private vectorChannel: VectorSearchChannel | null = null;

  constructor(private storage: StorageDatabase) {}

  /** Wire a vector search channel for use in `searchMulti()`. */
  setVectorChannel(channel: VectorSearchChannel | null): void {
    this.vectorChannel = channel;
  }

  hasVectorChannel(): boolean {
    return this.vectorChannel !== null;
  }

  /**
   * Full-text search using FTS5 with BM25 ranking.
   */
  search(options: SearchOptions): SearchResult[] {
    const { query, namespace, types, limit = 20, offset = 0, minConfidence = 0 } = options;

    if (!query.trim()) return [];

    const ftsQuery = sanitizeFtsQuery(query);
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
      entity: rawRowToEntity(row),
      score: Math.abs(row.rank as number), // BM25 returns negative scores
      matchChannel: 'fulltext' as const,
    }));
  }

  /**
   * Multi-channel search with Reciprocal Rank Fusion.
   *
   * Defaults: if `channels` is omitted, runs `['fulltext', 'vector']` when a
   * vector channel is available, else `['fulltext']`. Single-channel requests
   * skip the RRF pass and return the channel's results directly.
   *
   * Async because vector search must embed the query string remotely.
   */
  async searchMulti(options: SearchOptions): Promise<SearchResult[]> {
    const { query } = options;
    if (!query.trim()) return [];

    const requested = options.channels;
    const channels: ('fulltext' | 'vector')[] = (() => {
      if (requested && requested.length > 0) {
        return requested.filter((c): c is 'fulltext' | 'vector' => c === 'fulltext' || c === 'vector');
      }
      return this.vectorChannel ? ['fulltext', 'vector'] : ['fulltext'];
    })();

    const lists: RankedResult[][] = [];

    if (channels.includes('fulltext')) {
      lists.push(fulltextToRanked(this.search(options)));
    }
    if (channels.includes('vector') && this.vectorChannel) {
      lists.push(await this.vectorChannel.search(options));
    }

    if (lists.length === 0) return [];
    if (lists.length === 1) {
      return lists[0]
        .slice(0, options.limit ?? 20)
        .map((r) => ({ entity: r.entity, score: r.channelScore, matchChannel: r.channel }));
    }

    return reciprocalRankFusion(lists).slice(0, options.limit ?? 20);
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
}
