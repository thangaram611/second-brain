import { eq, and, like, sql, desc } from 'drizzle-orm';
import { newId } from './id.js';
import type {
  Entity,
  CreateEntityInput,
  UpsertEntityInput,
  UpdateEntityInput,
  EntityType,
} from '@second-brain/types';
import { isEntityType, isSourceType } from '@second-brain/types';
import { entities } from '../schema/index.js';
import type { DrizzleDB } from '../storage/index.js';

function rowToEntity(row: typeof entities.$inferSelect): Entity {
  // The drizzle `text` columns are typed as plain `string`; validate the
  // enum-constrained columns with the authoritative type guards. A row we
  // wrote with an out-of-enum type/source is a real bug worth surfacing.
  if (!isEntityType(row.type)) {
    throw new Error(`rowToEntity: invalid entity type "${row.type}" for id ${row.id}`);
  }
  if (!isSourceType(row.sourceType)) {
    throw new Error(`rowToEntity: invalid source type "${row.sourceType}" for id ${row.id}`);
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    namespace: row.namespace,
    observations: row.observations ?? [],
    properties: row.properties ?? {},
    confidence: row.confidence,
    eventTime: row.eventTime,
    ingestTime: row.ingestTime,
    lastAccessedAt: row.lastAccessedAt ?? row.createdAt,
    accessCount: row.accessCount,
    source: {
      type: row.sourceType,
      ref: row.sourceRef ?? undefined,
      actor: row.sourceActor ?? undefined,
    },
    tags: row.tags ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class EntityManager {
  constructor(private db: DrizzleDB) {}

  private buildRow(id: string, input: CreateEntityInput): typeof entities.$inferSelect {
    const now = new Date().toISOString();
    return {
      id,
      type: input.type,
      name: input.name,
      namespace: input.namespace ?? 'personal',
      observations: input.observations ?? [],
      properties: input.properties ?? {},
      confidence: input.confidence ?? 1.0,
      eventTime: input.eventTime ?? now,
      ingestTime: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceType: input.source.type,
      sourceRef: input.source.ref ?? null,
      sourceActor: input.source.actor ?? null,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  create(input: CreateEntityInput): Entity {
    const row = this.buildRow(newId(), input);
    this.db.insert(entities).values(row).run();
    return rowToEntity(row);
  }

  get(id: string): Entity | null {
    const row = this.db.select().from(entities).where(eq(entities.id, id)).get();
    return row ? rowToEntity(row) : null;
  }

  update(id: string, patch: UpdateEntityInput): Entity | null {
    const existing = this.db.select().from(entities).where(eq(entities.id, id)).get();
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: Partial<typeof entities.$inferInsert> = { updatedAt: now };

    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.namespace !== undefined) updates.namespace = patch.namespace;
    if (patch.observations !== undefined) updates.observations = patch.observations;
    if (patch.properties !== undefined) updates.properties = patch.properties;
    if (patch.confidence !== undefined) updates.confidence = patch.confidence;
    if (patch.tags !== undefined) updates.tags = patch.tags;

    this.db.update(entities).set(updates).where(eq(entities.id, id)).run();

    const updated = this.db.select().from(entities).where(eq(entities.id, id)).get();
    return updated ? rowToEntity(updated) : null;
  }

  delete(id: string): boolean {
    const result = this.db.delete(entities).where(eq(entities.id, id)).run();
    return result.changes > 0;
  }

  addObservation(id: string, observation: string): Entity | null {
    const existing = this.db.select().from(entities).where(eq(entities.id, id)).get();
    if (!existing) return null;

    const observations = [...(existing.observations ?? []), observation];
    return this.update(id, { observations });
  }

  removeObservation(id: string, observation: string): Entity | null {
    const existing = this.db.select().from(entities).where(eq(entities.id, id)).get();
    if (!existing) return null;

    const observations = (existing.observations ?? []).filter((o) => o !== observation);
    return this.update(id, { observations });
  }

  batchUpsert(inputs: CreateEntityInput[]): Entity[] {
    return inputs.map((input) => {
      // Try to find existing by name + namespace + type
      const existing = this.db
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.name, input.name),
            eq(entities.namespace, input.namespace ?? 'personal'),
            eq(entities.type, input.type),
          ),
        )
        .get();

      if (existing) {
        // Merge observations
        const mergedObs = Array.from(
          new Set([...(existing.observations ?? []), ...(input.observations ?? [])]),
        );
        const mergedTags = Array.from(
          new Set([...(existing.tags ?? []), ...(input.tags ?? [])]),
        );
        return this.update(existing.id, {
          observations: mergedObs,
          tags: mergedTags,
          properties: { ...(existing.properties ?? {}), ...(input.properties ?? {}) },
        })!;
      }

      return this.create(input);
    });
  }

  /**
   * Upsert keyed strictly on `input.id` (the authoritative CRDT id), NOT on
   * name+namespace+type like {@link batchUpsert}. A remote rename or any
   * remote-created row must keep the local row's id equal to the Y.Doc id so
   * subsequent remote deletes (which key on that id) actually hit the row.
   * On hit, merges observations/tags/properties like batchUpsert; on miss,
   * inserts a row keyed to `input.id` directly (no fresh ULID).
   */
  upsertById(input: UpsertEntityInput): Entity {
    const existing = this.db.select().from(entities).where(eq(entities.id, input.id)).get();

    if (existing) {
      const mergedObs = Array.from(
        new Set([...(existing.observations ?? []), ...(input.observations ?? [])]),
      );
      const mergedTags = Array.from(
        new Set([...(existing.tags ?? []), ...(input.tags ?? [])]),
      );
      return this.update(existing.id, {
        name: input.name,
        namespace: input.namespace ?? existing.namespace,
        observations: mergedObs,
        tags: mergedTags,
        properties: { ...(existing.properties ?? {}), ...(input.properties ?? {}) },
        confidence: input.confidence,
      })!;
    }

    const row = this.buildRow(input.id, input);
    this.db.insert(entities).values(row).run();
    return rowToEntity(row);
  }

  findByName(name: string, namespace?: string): Entity[] {
    const conditions = [like(entities.name, `%${name}%`)];
    if (namespace) conditions.push(eq(entities.namespace, namespace));

    const rows = this.db
      .select()
      .from(entities)
      .where(and(...conditions))
      .all();

    return rows.map(rowToEntity);
  }

  findByType(type: EntityType, namespace?: string): Entity[] {
    const conditions = [eq(entities.type, type)];
    if (namespace) conditions.push(eq(entities.namespace, namespace));

    const rows = this.db
      .select()
      .from(entities)
      .where(and(...conditions))
      .orderBy(desc(entities.updatedAt), desc(entities.id))
      .all();

    return rows.map(rowToEntity);
  }

  /**
   * Find entities of `type` whose JSON property at `jsonPath` equals `value`.
   *
   * `jsonPath` uses SQLite `json_extract` path syntax, e.g. `$.iid` or
   * `$.branchContext.branch`. Comparison is strict SQL equality: number
   * parameters match JSON numbers, string parameters match JSON strings.
   * Uses the `entities.properties` TEXT column directly — no generated
   * column is required, so callers can key on arbitrary paths without a
   * schema change.
   *
   * Phase 10.3 uses this for MR dedup on `(type='merge_request',
   * properties.projectId, properties.iid)` because `findByName` is a
   * `LIKE %substring%` match and MR title edits would break the name key.
   */
  findByTypeAndProperty(
    type: EntityType,
    jsonPath: string,
    value: string | number,
    namespace?: string,
  ): Entity[] {
    const conditions = [
      eq(entities.type, type),
      sql`json_extract(${entities.properties}, ${jsonPath}) = ${value}`,
    ];
    if (namespace) conditions.push(eq(entities.namespace, namespace));
    const rows = this.db
      .select()
      .from(entities)
      .where(and(...conditions))
      .all();
    return rows.map(rowToEntity);
  }

  touch(id: string): void {
    const now = new Date().toISOString();
    this.db
      .update(entities)
      .set({
        lastAccessedAt: now,
        accessCount: sql`${entities.accessCount} + 1`,
        updatedAt: now,
      })
      .where(eq(entities.id, id))
      .run();
  }

  list(options?: { namespace?: string; limit?: number; offset?: number }): Entity[] {
    let query = this.db.select().from(entities).$dynamic();

    if (options?.namespace) {
      query = query.where(eq(entities.namespace, options.namespace));
    }

    // Newest first. `id` (a time-ordered ULID, unique) is the tiebreaker so
    // pagination stays stable even when many rows share an `updatedAt`
    // (e.g. a bulk AST import) — without it, LIMIT/OFFSET could skip or repeat.
    const rows = query
      .orderBy(desc(entities.updatedAt), desc(entities.id))
      .limit(options?.limit ?? 100)
      .offset(options?.offset ?? 0)
      .all();

    return rows.map(rowToEntity);
  }

  count(namespace?: string): number {
    const condition = namespace ? eq(entities.namespace, namespace) : undefined;
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(condition)
      .get();
    return result?.count ?? 0;
  }

  /**
   * List every entity whose `properties.branchContext.branch` matches the
   * given branch. Uses the indexed `branch_context_branch` generated column.
   */
  listByBranchContext(
    branch: string,
    options?: { status?: 'wip' | 'merged' | 'abandoned'; namespace?: string; limit?: number },
  ): Entity[] {
    const parts = [sql`branch_context_branch = ${branch}`];
    if (options?.status) parts.push(sql`branch_context_status = ${options.status}`);
    if (options?.namespace) parts.push(sql`namespace = ${options.namespace}`);
    const where = sql.join(parts, sql` AND `);
    const rows = this.db
      .select()
      .from(entities)
      .where(where)
      .orderBy(sql`updated_at DESC`)
      .limit(options?.limit ?? 10_000)
      .all();
    return rows.map(rowToEntity);
  }
}
