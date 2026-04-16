import type { PersonalityStream, PersonalityContext } from '../personality-extractor.js';
import { rawRowToRelation } from '@second-brain/core';

/**
 * Aggregates `uses` relations to surface tech/tool familiarity.
 * Pure computation — no LLM required.
 */
export class TechFamiliarityStream implements PersonalityStream {
  readonly name = 'tech-familiarity';

  async run(ctx: PersonalityContext): Promise<{ created: number; updated: number }> {
    const { brain, actor, logger, now } = ctx;

    // Query all 'uses' relations where source_actor matches
    const rows = brain.storage.sqlite
      .prepare(
        `SELECT * FROM relations
         WHERE type = 'uses'
           AND source_actor = ?`,
      )
      .all(actor) as Record<string, unknown>[];

    if (rows.length === 0) {
      logger.info(`[tech-familiarity] no 'uses' relations for actor=${actor}`);
      return { created: 0, updated: 0 };
    }

    const relations = rows.map(rawRowToRelation);

    // Group by target entity — count occurrences, track latest update and source IDs
    const techMap = new Map<
      string,
      { name: string; count: number; lastDate: string; sourceEntityIds: string[] }
    >();

    for (const rel of relations) {
      const targetEntity = brain.entities.get(rel.targetId);
      if (!targetEntity) continue;

      const key = targetEntity.name;
      const entry = techMap.get(key) ?? {
        name: targetEntity.name,
        count: 0,
        lastDate: rel.updatedAt,
        sourceEntityIds: [],
      };

      entry.count += 1;
      if (rel.updatedAt > entry.lastDate) entry.lastDate = rel.updatedAt;
      if (entry.sourceEntityIds.length < 5) {
        entry.sourceEntityIds.push(rel.sourceId);
      }
      techMap.set(key, entry);
    }

    // Take top 50 by count
    const sorted = [...techMap.values()].sort((a, b) => b.count - a.count).slice(0, 50);

    let created = 0;
    let updated = 0;

    for (const tech of sorted) {
      const entityName = `tech-familiarity:${tech.name}`;
      const props = {
        tech: tech.name,
        depth: tech.count,
        lastTouched: tech.lastDate,
      };
      const confidence = Math.min(tech.count / 10, 1.0);

      const result = upsertPersonalityFact(ctx, entityName, props, confidence, now);

      if (result.action === 'created') created++;
      else updated++;

      // Create derived_from relations (up to 5 per tech)
      for (const sourceEntityId of tech.sourceEntityIds) {
        brain.relations.createOrGet({
          type: 'derived_from',
          sourceId: result.entityId,
          targetId: sourceEntityId,
          namespace: 'personal',
          source: { type: 'personality', ref: 'tech-familiarity', actor },
          properties: { streamName: 'tech-familiarity', createdAt: now.toISOString() },
        });
      }
    }

    return { created, updated };
  }
}

function upsertPersonalityFact(
  ctx: PersonalityContext,
  entityName: string,
  properties: Record<string, unknown>,
  confidence: number,
  now: Date,
): { action: 'created' | 'updated'; entityId: string } {
  const { brain, actor } = ctx;

  const existing = brain.entities
    .findByName(entityName, 'personal')
    .filter((e) => e.name === entityName);

  if (existing.length > 0) {
    brain.entities.update(existing[0].id, { properties, confidence });
    return { action: 'updated', entityId: existing[0].id };
  }

  const entity = brain.entities.create({
    type: 'fact',
    name: entityName,
    namespace: 'personal',
    source: { type: 'personality', ref: 'tech-familiarity', actor },
    properties,
    confidence,
    tags: ['personality', 'tech-familiarity'],
    eventTime: now.toISOString(),
  });
  return { action: 'created', entityId: entity.id };
}

export default TechFamiliarityStream;
