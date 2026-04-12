import { eq, and, like, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type { Entity, CreateEntityInput, UpdateEntityInput, EntityType } from '@second-brain/types';
import { entities } from '../schema/index.js';
import type { DrizzleDB } from '../storage/index.js';

function rowToEntity(row: typeof entities.$inferSelect): Entity {
  return {
    id: row.id,
    type: row.type as EntityType,
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
      type: row.sourceType as Entity['source']['type'],
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

  create(input: CreateEntityInput): Entity {
    const now = new Date().toISOString();
    const id = ulid();

    const row = {
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

    const rows = query
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
}
