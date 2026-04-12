import { eq, and, or, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type { Relation, CreateRelationInput, RelationType, Entity, EntityType } from '@second-brain/types';
import { entities, relations } from '../schema/index.js';
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

  get(id: string): Relation | null {
    const row = this.db.select().from(relations).where(eq(relations.id, id)).get();
    return row ? rowToRelation(row) : null;
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

  /**
   * Get neighbor entities up to a given depth using BFS.
   */
  getNeighbors(
    entityId: string,
    depth = 1,
    types?: RelationType[],
  ): { entities: Entity[]; relations: Relation[] } {
    const visitedEntities = new Set<string>([entityId]);
    const collectedRelations: Relation[] = [];
    let frontier = [entityId];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const rels = this.getAll(nodeId);

        for (const rel of rels) {
          if (types && !types.includes(rel.type)) continue;

          collectedRelations.push(rel);
          const neighborId = rel.sourceId === nodeId ? rel.targetId : rel.sourceId;

          if (!visitedEntities.has(neighborId)) {
            visitedEntities.add(neighborId);
            nextFrontier.push(neighborId);
          }
        }
      }

      frontier = nextFrontier;
    }

    // Fetch all visited entity rows
    const entityRows: Entity[] = [];
    for (const eid of visitedEntities) {
      if (eid === entityId) continue; // Exclude the seed
      const row = this.db.select().from(entities).where(eq(entities.id, eid)).get();
      if (row) {
        entityRows.push({
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
        });
      }
    }

    // Deduplicate relations by id
    const uniqueRelations = [...new Map(collectedRelations.map((r) => [r.id, r])).values()];

    return { entities: entityRows, relations: uniqueRelations };
  }

  /**
   * Find all paths between two entities using BFS, up to maxDepth hops.
   * Returns an array of paths, where each path is an array of Relations.
   */
  findPath(
    fromId: string,
    toId: string,
    maxDepth = 5,
  ): Relation[][] {
    const results: Relation[][] = [];

    // BFS with path tracking: each queue entry is [currentEntityId, pathSoFar]
    const queue: Array<[string, Relation[]]> = [[fromId, []]];
    const visited = new Set<string>([fromId]);

    while (queue.length > 0) {
      const [currentId, path] = queue.shift()!;

      if (path.length >= maxDepth) continue;

      const rels = this.getAll(currentId);
      for (const rel of rels) {
        const neighborId = rel.sourceId === currentId ? rel.targetId : rel.sourceId;
        const newPath = [...path, rel];

        if (neighborId === toId) {
          results.push(newPath);
          continue;
        }

        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push([neighborId, newPath]);
        }
      }
    }

    return results;
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
}
