import type { BranchStatusPatch, DecayEngineConfig, EntityType } from '@second-brain/types';
import { BranchStatusPatchSchema, sessionNamespace } from '@second-brain/types';
import { z } from 'zod';
import { StorageDatabase, type DatabaseOptions } from './storage/index.js';
import { EntityManager } from './graph/entity-manager.js';
import { RelationManager } from './graph/relation-manager.js';
import { SearchEngine } from './search/search-engine.js';
import { BitemporalQueries } from './temporal/bitemporal-queries.js';
import { DecayEngine } from './temporal/decay-engine.js';
import { ContradictionDetector } from './temporal/contradiction-detector.js';
import { EmbeddingStore } from './embeddings/index.js';

export interface PromoteSessionOptions {
  /** Restrict which entity types get their namespace rewritten. */
  entityTypeFilter?: EntityType[];
}

export interface PromoteSessionResult {
  promotedEntities: number;
  promotedRelations: number;
  skipped: number;
}

export interface FlipBranchStatusResult {
  updatedEntities: number;
  updatedRelations: number;
}

export interface ParallelWorkQuery {
  /** Restrict to entities whose relations carry this branch. */
  branch?: string;
  /** Restrict to entities in this namespace. */
  namespace?: string;
  /** Substring match against entity.name (useful for file-path fragments). */
  pathLike?: string;
  /** Max rows to return (default 50). */
  limit?: number;
}

export interface ParallelWorkRow {
  entityId: string;
  entityType: string;
  entityName: string;
  namespace: string;
  /** Distinct source_actor values from WIP relations touching the entity. */
  actors: string[];
  /** Distinct branches WIP-touching the entity. */
  branches: string[];
}

const ParallelWorkRowDbSchema = z.object({
  entityId: z.string(),
  entityType: z.string(),
  entityName: z.string(),
  namespace: z.string(),
  actors_csv: z.string().nullable(),
  branches_csv: z.string().nullable(),
  actor_count: z.number().int(),
});

export interface BrainOptions extends DatabaseOptions {
  decay?: DecayEngineConfig;
}

/**
 * Main entry point — wraps storage, graph, search, and temporal into a single API.
 */
export class Brain {
  readonly storage: StorageDatabase;
  readonly entities: EntityManager;
  readonly relations: RelationManager;
  readonly search: SearchEngine;
  readonly temporal: BitemporalQueries;
  readonly decay: DecayEngine;
  readonly contradictions: ContradictionDetector;
  /**
   * Vector embedding store. Non-null only when `vectorDimensions` was set
   * in BrainOptions or `enableVectorSearch()` was called on storage.
   */
  readonly embeddings: EmbeddingStore | null;

  constructor(options: BrainOptions) {
    this.storage = new StorageDatabase(options);
    this.entities = new EntityManager(this.storage.db);
    this.relations = new RelationManager(this.storage.db);
    this.search = new SearchEngine(this.storage);
    this.temporal = new BitemporalQueries(this.storage);
    this.decay = new DecayEngine(this.storage, options.decay);
    this.contradictions = new ContradictionDetector(this.storage, this.relations, this.entities);
    this.embeddings = this.storage.vectorDimensions !== null ? new EmbeddingStore(this.storage) : null;
  }

  /**
   * Enable vector search after construction (e.g. when the LLM config is
   * loaded later). Idempotent for the same dimension.
   */
  enableVectorSearch(dimensions: number): EmbeddingStore {
    this.storage.enableVectorSearch(dimensions);
    if (this.embeddings === null) {
      // EmbeddingStore is readonly but we set it in the constructor based on
      // storage state — once enabled, replace via Object.defineProperty so the
      // public type stays accurate without a non-readonly field.
      Object.defineProperty(this, 'embeddings', {
        value: new EmbeddingStore(this.storage),
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    if (this.embeddings === null) throw new Error('enableVectorSearch failed to initialize EmbeddingStore');
    return this.embeddings;
  }

  /**
   * Rewrite the namespace of every entity (and surviving relations) in a
   * session namespace to a target namespace (typically `personal` or a
   * project ID). Dangling relations — whose endpoint never lived in the
   * session namespace — are left in place for audit and counted as skipped.
   *
   * Runs in a single transaction. Fine for sessions of <1k entities; larger
   * sessions would benefit from batched transactions (future optimization).
   */
  promoteSession(
    sessionId: string,
    to: string,
    options?: PromoteSessionOptions,
  ): PromoteSessionResult {
    const fromNs = sessionNamespace(sessionId);
    const filter = options?.entityTypeFilter;

    let promotedEntities = 0;
    let promotedRelations = 0;
    let skipped = 0;

    this.storage.sqlite.transaction(() => {
      const entitiesInSession = this.entities.list({ namespace: fromNs, limit: 100_000 });
      const promotedEntityIds = new Set<string>();

      for (const entity of entitiesInSession) {
        if (filter && !filter.includes(entity.type)) continue;
        this.entities.update(entity.id, { namespace: to });
        promotedEntityIds.add(entity.id);
        promotedEntities++;
      }

      const relationsInSession = this.relations.listByNamespace(fromNs);
      for (const rel of relationsInSession) {
        // A relation is only promotable if both endpoints are now in the
        // target namespace. Otherwise, leave it behind in session namespace
        // so we retain an audit trail without creating a cross-namespace
        // dangling edge.
        const sourcePromoted = promotedEntityIds.has(rel.sourceId);
        const targetPromoted = promotedEntityIds.has(rel.targetId);
        if (sourcePromoted && targetPromoted) {
          this.relations.update(rel.id, { namespace: to });
          promotedRelations++;
        } else {
          skipped++;
        }
      }
    })();

    return { promotedEntities, promotedRelations, skipped };
  }

  /**
   * Bulk-update `properties.branchContext` on every entity and relation whose
   * `branch_context_branch` generated column matches `branch`. Single
   * transaction, two prepared UPDATE statements — O(log n) via the index
   * from migration 002.
   *
   * Note: this is the only raw-SQL bulk write in `Brain`; other mutations go
   * through EntityManager/RelationManager. We drop to SQL here because a
   * long-lived branch can have thousands of entities and per-row JSON rewrites
   * via the ORM would be N+1.
   */
  flipBranchStatus(branch: string, patch: BranchStatusPatch): FlipBranchStatusResult {
    if (typeof branch !== 'string' || branch.length === 0) {
      throw new Error('flipBranchStatus: branch must be a non-empty string');
    }
    const validated = BranchStatusPatchSchema.parse(patch);
    const sqlite = this.storage.sqlite;
    return sqlite.transaction(() => {
      const params = {
        status: validated.status,
        mrIid: validated.mrIid ?? null,
        mergedAt: validated.mergedAt ?? null,
        now: new Date().toISOString(),
        branch,
      };
      const eStmt = sqlite.prepare(`
        UPDATE entities
        SET properties = json_set(
          COALESCE(properties, '{}'),
          '$.branchContext.status',   @status,
          '$.branchContext.mrIid',    @mrIid,
          '$.branchContext.mergedAt', @mergedAt
        ),
        updated_at = @now
        WHERE branch_context_branch = @branch
      `);
      const rStmt = sqlite.prepare(`
        UPDATE relations
        SET properties = json_set(
          COALESCE(properties, '{}'),
          '$.branchContext.status',   @status,
          '$.branchContext.mrIid',    @mrIid,
          '$.branchContext.mergedAt', @mergedAt
        ),
        updated_at = @now
        WHERE branch_context_branch = @branch
      `);
      const eRes = eStmt.run(params);
      const rRes = rStmt.run(params);
      return {
        updatedEntities: Number(eRes.changes),
        updatedRelations: Number(rRes.changes),
      };
    })();
  }

  /**
   * Find entities touched by ≥2 distinct actors on WIP relations (across one
   * or more branches). Surfaces collisions before they become merge conflicts.
   *
   * Uses SQLite `group_concat(DISTINCT …)` — supported since 3.7; bundled
   * with better-sqlite3 is 3.40+. `HAVING` on a count aggregate; we repeat
   * the `count(DISTINCT …)` rather than reference the alias because SQLite
   * does not require it but it's portable across versions.
   */
  findParallelWork(query: ParallelWorkQuery = {}): ParallelWorkRow[] {
    const limit = query.limit ?? 50;
    const clauses: string[] = [
      `r.branch_context_status = 'wip'`,
      `r.source_actor IS NOT NULL`,
      `r.branch_context_branch IS NOT NULL`,
    ];
    if (query.branch) clauses.push(`r.branch_context_branch = @branch`);
    if (query.namespace) clauses.push(`e.namespace = @namespace`);
    if (query.pathLike) clauses.push(`e.name LIKE @pathLike`);
    const where = clauses.join(' AND ');
    const sql = `
      SELECT
        e.id             AS entityId,
        e.type           AS entityType,
        e.name           AS entityName,
        e.namespace      AS namespace,
        group_concat(DISTINCT r.source_actor) AS actors_csv,
        group_concat(DISTINCT r.branch_context_branch) AS branches_csv,
        count(DISTINCT r.source_actor) AS actor_count
      FROM entities e
      JOIN relations r ON r.target_id = e.id
      WHERE ${where}
      GROUP BY e.id
      HAVING count(DISTINCT r.source_actor) >= 2
      ORDER BY count(DISTINCT r.source_actor) DESC, e.updated_at DESC
      LIMIT @limit
    `;
    const stmt = this.storage.sqlite.prepare(sql);
    // better-sqlite3 rejects named params that aren't referenced in the SQL,
    // so build the bindings object conditionally to match the WHERE clauses.
    const bindings: Record<string, unknown> = { limit };
    if (query.branch) bindings.branch = query.branch;
    if (query.namespace) bindings.namespace = query.namespace;
    if (query.pathLike) bindings.pathLike = `%${query.pathLike}%`;
    const rawRows = stmt.all(bindings);
    return rawRows.map((raw) => {
      const row = ParallelWorkRowDbSchema.parse(raw);
      return {
        entityId: row.entityId,
        entityType: row.entityType,
        entityName: row.entityName,
        namespace: row.namespace,
        actors: (row.actors_csv ?? '').split(',').filter((s) => s.length > 0),
        branches: (row.branches_csv ?? '').split(',').filter((s) => s.length > 0),
      };
    });
  }

  close(): void {
    this.decay.stop();
    this.storage.close();
  }
}
