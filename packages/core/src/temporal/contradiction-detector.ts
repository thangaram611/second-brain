import type { Entity, Contradiction } from '@second-brain/types';
import type { StorageDatabase } from '../storage/index.js';
import type { EntityManager } from '../graph/entity-manager.js';
import type { RelationManager } from '../graph/relation-manager.js';
import { rawRowToRelation, rawRowToEntity } from './row-mappers.js';

/**
 * Detects and manages contradictions between entities.
 * A contradiction is a 'contradicts' relation where neither entity has been superseded.
 */
export class ContradictionDetector {
  constructor(
    private storage: StorageDatabase,
    private relations: RelationManager,
    private entities: EntityManager,
  ) {}

  /**
   * Find all unresolved contradictions.
   * Deduplicates symmetric pairs (A→B and B→A) by keeping only the row
   * where source_id < target_id, plus any unpaired reverse relations.
   */
  getUnresolved(namespace?: string): Contradiction[] {
    let namespaceFilter = '';
    const params: unknown[] = [];

    if (namespace) {
      namespaceFilter = ` AND r.namespace = ?`;
      params.push(namespace);
    }

    // Fetch deduplicated contradiction relations
    // 1) Keep relations where source_id < target_id (canonical direction)
    // 2) Also keep reverse relations where no canonical version exists
    const sql = `
      SELECT r.* FROM relations r
      WHERE r.type = 'contradicts'
        AND r.source_id NOT IN (SELECT target_id FROM relations WHERE type = 'supersedes')
        AND r.target_id NOT IN (SELECT target_id FROM relations WHERE type = 'supersedes')
        AND r.source_id < r.target_id
        ${namespaceFilter}
      UNION ALL
      SELECT r.* FROM relations r
      WHERE r.type = 'contradicts'
        AND r.source_id NOT IN (SELECT target_id FROM relations WHERE type = 'supersedes')
        AND r.target_id NOT IN (SELECT target_id FROM relations WHERE type = 'supersedes')
        AND r.source_id >= r.target_id
        AND NOT EXISTS (
          SELECT 1 FROM relations r2
          WHERE r2.type = 'contradicts' AND r2.source_id = r.target_id AND r2.target_id = r.source_id
        )
        ${namespaceFilter}
    `;

    // Duplicate namespace params for UNION ALL
    const allParams = namespace ? [...params, ...params] : [];
    const rows = this.storage.sqlite.prepare(sql).all(...allParams) as Array<
      Record<string, unknown>
    >;

    if (rows.length === 0) return [];

    // Batch-fetch all referenced entities to avoid N+1
    const entityIds = new Set<string>();
    for (const row of rows) {
      entityIds.add(row.source_id as string);
      entityIds.add(row.target_id as string);
    }

    const placeholders = [...entityIds].map(() => '?').join(',');
    const entityRows = this.storage.sqlite
      .prepare(`SELECT * FROM entities WHERE id IN (${placeholders})`)
      .all(...entityIds) as Array<Record<string, unknown>>;

    const entityMap = new Map<string, Entity>();
    for (const row of entityRows) {
      const entity = rawRowToEntity(row);
      entityMap.set(entity.id, entity);
    }

    // Build contradiction pairs
    const contradictions: Contradiction[] = [];
    for (const row of rows) {
      const relation = rawRowToRelation(row);
      const entityA = entityMap.get(relation.sourceId);
      const entityB = entityMap.get(relation.targetId);
      if (entityA && entityB) {
        contradictions.push({ relation, entityA, entityB });
      }
    }

    return contradictions;
  }

  /**
   * Resolve a contradiction by picking a winner.
   * Creates a 'supersedes' relation from winner to loser and sets loser confidence to 0.
   */
  resolve(contradictionRelationId: string, winnerId: string): void {
    const relation = this.relations.get(contradictionRelationId);
    if (!relation || relation.type !== 'contradicts') {
      throw new Error(`Relation ${contradictionRelationId} is not a contradicts relation`);
    }

    const loserId = relation.sourceId === winnerId ? relation.targetId : relation.sourceId;

    // Verify both entities exist
    const winner = this.entities.get(winnerId);
    const loser = this.entities.get(loserId);
    if (!winner) throw new Error(`Winner entity ${winnerId} not found`);
    if (!loser) throw new Error(`Loser entity ${loserId} not found`);

    // Create supersedes relation: winner → loser
    this.relations.create({
      type: 'supersedes',
      sourceId: winnerId,
      targetId: loserId,
      namespace: relation.namespace,
      source: { type: 'manual', actor: 'contradiction-resolver' },
      properties: { resolvedFrom: contradictionRelationId },
    });

    // Set loser confidence to 0
    this.entities.update(loserId, { confidence: 0 });

    // Delete the contradicts relation
    this.relations.delete(contradictionRelationId);
  }

  /**
   * Dismiss a contradiction without resolving it (delete the contradicts relation).
   */
  dismiss(contradictionRelationId: string): void {
    const relation = this.relations.get(contradictionRelationId);
    if (!relation || relation.type !== 'contradicts') {
      throw new Error(`Relation ${contradictionRelationId} is not a contradicts relation`);
    }
    this.relations.delete(contradictionRelationId);
  }

  /**
   * Find entities that might contradict a given entity
   * (same type, name, and namespace but different ID).
   */
  detectPotential(entity: Entity): Entity[] {
    const rows = this.storage.sqlite
      .prepare(
        `SELECT * FROM entities WHERE type = ? AND namespace = ? AND name = ? AND id != ?`,
      )
      .all(entity.type, entity.namespace, entity.name, entity.id) as Array<
      Record<string, unknown>
    >;
    return rows.map(rawRowToEntity);
  }
}
