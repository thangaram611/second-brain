import type { Entity, Relation, RelationType } from '@second-brain/types';
import type { RelationManager } from './relation-manager.js';
import type { EntityManager } from './entity-manager.js';

/**
 * Graph traversal algorithms (BFS neighbors, shortest-path) extracted from
 * RelationManager to separate CRUD from graph algorithms.
 */
export class GraphTraversal {
  constructor(
    private relations: RelationManager,
    private entities: EntityManager,
  ) {}

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
        const rels = this.relations.getAll(nodeId);

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
      const entity = this.entities.get(eid);
      if (entity) {
        entityRows.push(entity);
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

      const rels = this.relations.getAll(currentId);
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
}
