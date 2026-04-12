import type * as Y from 'yjs';
import type { EntityManager, RelationManager } from '@second-brain/core';
import { entityToYMap, relationToYMap } from './schema.js';

/**
 * Hydrates a Y.Doc from SQLite by paginating through all entities and
 * their outbound relations for the given namespace. All mutations are
 * wrapped in a single transaction with origin 'hydrate' so that the
 * SyncBridge observer can skip them.
 */
export function hydrateDocFromDatabase(
  doc: Y.Doc,
  entityManager: EntityManager,
  relationManager: RelationManager,
  namespace: string,
): void {
  const PAGE_SIZE = 500;
  const seenRelationIds = new Set<string>();

  doc.transact(() => {
    // Paginate through entities
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const entities = entityManager.list({ namespace, limit: PAGE_SIZE, offset });
      if (entities.length === 0) break;

      for (const entity of entities) {
        entityToYMap(doc, entity);

        // Collect outbound relations for each entity
        const outbound = relationManager.getOutbound(entity.id);
        for (const relation of outbound) {
          if (!seenRelationIds.has(relation.id)) {
            seenRelationIds.add(relation.id);
            relationToYMap(doc, relation);
          }
        }
      }

      offset += entities.length;
      // If we got fewer than PAGE_SIZE, we've exhausted the list
      if (entities.length < PAGE_SIZE) break;
    }
  }, 'hydrate');
}
