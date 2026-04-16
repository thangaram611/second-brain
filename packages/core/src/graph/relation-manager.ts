import { eq, and, or, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type {
  Relation,
  CreateRelationInput,
  UpdateRelationInput,
  RelationType,
} from '@second-brain/types';
import { relations } from '../schema/index.js';
import type { DrizzleDB } from '../storage/index.js';

function rowToRelation(row: typeof relations.$inferSelect): Relation {
  return {
    id: row.id,
    type: row.type as RelationType,
    sourceId: row.sourceId,
    targetId: row.targetId,
    namespace: row.namespace,
    properties: row.properties ?? {},
    confidence: row.confidence,
    weight: row.weight,
    bidirectional: row.bidirectional,
    source: {
      type: row.sourceType as Relation['source']['type'],
      ref: row.sourceRef ?? undefined,
      actor: row.sourceActor ?? undefined,
    },
    eventTime: row.eventTime,
    ingestTime: row.ingestTime,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class RelationManager {
  constructor(private db: DrizzleDB) {}

  create(input: CreateRelationInput): Relation {
    const now = new Date().toISOString();
    const id = ulid();

    const row = {
      id,
      type: input.type,
      sourceId: input.sourceId,
      targetId: input.targetId,
      namespace: input.namespace ?? 'personal',
      properties: input.properties ?? {},
      confidence: input.confidence ?? 1.0,
      weight: input.weight ?? 1.0,
      bidirectional: input.bidirectional ?? false,
      sourceType: input.source.type,
      sourceRef: input.source.ref ?? null,
      sourceActor: input.source.actor ?? null,
      eventTime: input.eventTime ?? now,
      ingestTime: now,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(relations).values(row).run();
    return rowToRelation(row);
  }

  /**
   * Insert-or-return: creates the relation if no edge exists for the
   * (sourceId, targetId, type) triple (enforced by
   * `idx_relations_unique_edge`), otherwise returns the pre-existing row.
   *
   * Phase 10.3 — webhook replays and idempotent MR ingest must not throw
   * `SqliteError: UNIQUE constraint failed`. The existing `batchUpsert`
   * (line ~240) performs an update on hit; `createOrGet` is strictly
   * non-destructive (first writer wins on properties/weight/confidence).
   */
  createOrGet(input: CreateRelationInput): Relation {
    const existing = this.db
      .select()
      .from(relations)
      .where(
        and(
          eq(relations.sourceId, input.sourceId),
          eq(relations.targetId, input.targetId),
          eq(relations.type, input.type),
        ),
      )
      .get();
    if (existing) return rowToRelation(existing);
    return this.create(input);
  }

  get(id: string): Relation | null {
    const row = this.db.select().from(relations).where(eq(relations.id, id)).get();
    return row ? rowToRelation(row) : null;
  }

  update(id: string, patch: UpdateRelationInput): Relation | null {
    const existing = this.db.select().from(relations).where(eq(relations.id, id)).get();
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: Partial<typeof relations.$inferInsert> = { updatedAt: now };

    if (patch.namespace !== undefined) updates.namespace = patch.namespace;
    if (patch.properties !== undefined) updates.properties = patch.properties;
    if (patch.confidence !== undefined) updates.confidence = patch.confidence;
    if (patch.weight !== undefined) updates.weight = patch.weight;
    if (patch.bidirectional !== undefined) updates.bidirectional = patch.bidirectional;

    this.db.update(relations).set(updates).where(eq(relations.id, id)).run();

    const updated = this.db.select().from(relations).where(eq(relations.id, id)).get();
    return updated ? rowToRelation(updated) : null;
  }

  listByNamespace(namespace: string): Relation[] {
    return this.db
      .select()
      .from(relations)
      .where(eq(relations.namespace, namespace))
      .all()
      .map(rowToRelation);
  }

  delete(id: string): boolean {
    const result = this.db.delete(relations).where(eq(relations.id, id)).run();
    return result.changes > 0;
  }

  getOutbound(entityId: string, type?: RelationType): Relation[] {
    const conditions = [eq(relations.sourceId, entityId)];
    if (type) conditions.push(eq(relations.type, type));

    return this.db
      .select()
      .from(relations)
      .where(and(...conditions))
      .all()
      .map(rowToRelation);
  }

  getInbound(entityId: string, type?: RelationType): Relation[] {
    const conditions = [eq(relations.targetId, entityId)];
    if (type) conditions.push(eq(relations.type, type));

    return this.db
      .select()
      .from(relations)
      .where(and(...conditions))
      .all()
      .map(rowToRelation);
  }

  /**
   * Get all relations connected to an entity (both directions),
   * including bidirectional relations where the entity is the target.
   */
  getAll(entityId: string, type?: RelationType): Relation[] {
    const conditions = [
      or(eq(relations.sourceId, entityId), eq(relations.targetId, entityId)),
    ];
    if (type) conditions.push(eq(relations.type, type));

    return this.db
      .select()
      .from(relations)
      .where(and(...conditions))
      .all()
      .map(rowToRelation);
  }

  batchUpsert(inputs: CreateRelationInput[]): Relation[] {
    return inputs.map((input) => {
      // Check if edge already exists
      const existing = this.db
        .select()
        .from(relations)
        .where(
          and(
            eq(relations.sourceId, input.sourceId),
            eq(relations.targetId, input.targetId),
            eq(relations.type, input.type),
          ),
        )
        .get();

      if (existing) {
        // Update weight/confidence
        const now = new Date().toISOString();
        this.db
          .update(relations)
          .set({
            confidence: input.confidence ?? existing.confidence,
            weight: input.weight ?? existing.weight,
            properties: { ...(existing.properties ?? {}), ...(input.properties ?? {}) },
            updatedAt: now,
          })
          .where(eq(relations.id, existing.id))
          .run();

        const updated = this.db
          .select()
          .from(relations)
          .where(eq(relations.id, existing.id))
          .get();
        return rowToRelation(updated!);
      }

      return this.create(input);
    });
  }

  count(namespace?: string): number {
    const condition = namespace ? eq(relations.namespace, namespace) : undefined;
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(relations)
      .where(condition)
      .get();
    return result?.count ?? 0;
  }

  /**
   * Symmetric to EntityManager.listByBranchContext — returns relations whose
   * `properties.branchContext.branch` matches. Uses migration-002 generated
   * column on the relations table.
   */
  listByBranchContext(
    branch: string,
    options?: { status?: 'wip' | 'merged' | 'abandoned'; namespace?: string; limit?: number },
  ): Relation[] {
    const parts = [sql`branch_context_branch = ${branch}`];
    if (options?.status) parts.push(sql`branch_context_status = ${options.status}`);
    if (options?.namespace) parts.push(sql`namespace = ${options.namespace}`);
    const where = sql.join(parts, sql` AND `);
    const rows = this.db
      .select()
      .from(relations)
      .where(where)
      .orderBy(sql`updated_at DESC`)
      .limit(options?.limit ?? 10_000)
      .all();
    return rows.map(rowToRelation);
  }
}
