import { createHash } from 'node:crypto';
import type { CreateEntityInput, CreateRelationInput } from '@second-brain/types';
import type { Brain } from '../brain.js';
import type { PersonalBundle, ImportResult } from './types.js';

export interface ImportPersonalOptions {
  reattach?: boolean;
}

export interface ImportPersonalResult extends ImportResult {
  droppedDanglingEdges: number;
}

export function importPersonal(
  brain: Brain,
  bundle: PersonalBundle,
  options?: ImportPersonalOptions,
): ImportPersonalResult {
  const reattach = options?.reattach ?? false;

  // 1. Verify sha256
  const hashContent = JSON.stringify(bundle.entities) + JSON.stringify(bundle.relations);
  const computed = createHash('sha256').update(hashContent).digest('hex');
  if (computed !== bundle.sha256) {
    throw new Error(
      `SHA-256 mismatch: expected ${bundle.sha256}, computed ${computed}`,
    );
  }

  // 2. Wrap in a single SQLite transaction
  const danglingIds = new Set(bundle.manifest.danglingEntityIds);

  return brain.storage.sqlite.transaction(() => {
    // 3. Upsert entities
    const inputs: CreateEntityInput[] = bundle.entities.map((e) => ({
      type: e.type,
      name: e.name,
      namespace: 'personal',
      observations: e.observations,
      properties: e.properties,
      confidence: e.confidence,
      eventTime: e.eventTime,
      source: e.source,
      tags: e.tags,
    }));

    const upserted = brain.entities.batchUpsert(inputs);

    // Build old-id → new-id map by matching name+type
    const oldIdToNewId = new Map<string, string>();
    for (let i = 0; i < bundle.entities.length; i++) {
      const bundleEntity = bundle.entities[i];
      const localEntity = upserted[i];
      oldIdToNewId.set(bundleEntity.id, localEntity.id);
    }

    // 4. Process relations
    let relationsImported = 0;
    let droppedDanglingEdges = 0;
    const relationInputs: CreateRelationInput[] = [];

    for (const r of bundle.relations) {
      let sourceId = oldIdToNewId.get(r.sourceId);
      let targetId = oldIdToNewId.get(r.targetId);

      const sourceIsDangling = danglingIds.has(r.sourceId);
      const targetIsDangling = danglingIds.has(r.targetId);

      // Resolve dangling endpoints
      if (sourceIsDangling) {
        if (!reattach) {
          droppedDanglingEdges++;
          continue;
        }
        // reattach=true: check if the original ID exists locally
        const existing = brain.entities.get(r.sourceId);
        if (existing) {
          sourceId = r.sourceId;
        } else {
          droppedDanglingEdges++;
          continue;
        }
      }

      if (targetIsDangling) {
        if (!reattach) {
          droppedDanglingEdges++;
          continue;
        }
        const existing = brain.entities.get(r.targetId);
        if (existing) {
          targetId = r.targetId;
        } else {
          droppedDanglingEdges++;
          continue;
        }
      }

      if (!sourceId || !targetId) continue;

      relationInputs.push({
        type: r.type,
        sourceId,
        targetId,
        namespace: 'personal',
        properties: r.properties,
        confidence: r.confidence,
        weight: r.weight,
        bidirectional: r.bidirectional,
        source: r.source,
        eventTime: r.eventTime,
      });
    }

    if (relationInputs.length > 0) {
      const created = brain.relations.batchUpsert(relationInputs);
      relationsImported = created.length;
    }

    return {
      entitiesImported: upserted.length,
      relationsImported,
      droppedDanglingEdges,
      conflicts: [],
    };
  })();
}
