import type { PersonalityStream, PersonalityContext } from '../personality-extractor.js';
import { rawRowToRelation } from '@second-brain/core';
import type { Relation } from '@second-brain/types';

/**
 * Computes review-vs-authored ratio per namespace with 30/90/180-day trends.
 * Pure computation — no LLM required.
 */
export class ManagementSignalsStream implements PersonalityStream {
  readonly name = 'management-signals';

  async run(ctx: PersonalityContext): Promise<{ created: number; updated: number }> {
    const { brain, actor, logger, now } = ctx;

    const rows = brain.storage.sqlite
      .prepare(
        `SELECT * FROM relations
         WHERE source_actor = ?
           AND type IN ('reviewed_by', 'authored_by')`,
      )
      .all(actor) as Record<string, unknown>[];

    if (rows.length === 0) {
      logger.info(`[management-signals] no review/author relations for actor=${actor}`);
      return { created: 0, updated: 0 };
    }

    const relations = rows.map(rawRowToRelation);

    // Group by namespace
    const byNamespace = new Map<string, Relation[]>();
    for (const rel of relations) {
      const ns = rel.namespace;
      const list = byNamespace.get(ns) ?? [];
      list.push(rel);
      byNamespace.set(ns, list);
    }

    let created = 0;
    let updated = 0;

    for (const [namespace, rels] of byNamespace) {
      const allCounts = countByType(rels);
      const trend30d = countByType(filterByAge(rels, now, 30));
      const trend90d = countByType(filterByAge(rels, now, 90));
      const trend180d = countByType(filterByAge(rels, now, 180));

      const entityName = `management-signals:${namespace}`;
      const props = {
        targetNamespace: namespace,
        reviewCount: allCounts.reviews,
        authoredCount: allCounts.authored,
        reviewRatio: allCounts.ratio,
        trend30d,
        trend90d,
        trend180d,
      };
      const total = allCounts.reviews + allCounts.authored;
      const confidence = Math.min(total / 20, 1.0);

      const result = upsertPersonalityFact(ctx, entityName, props, confidence, now);
      if (result === 'created') created++;
      else updated++;
    }

    return { created, updated };
  }
}

function countByType(rels: Relation[]): {
  reviews: number;
  authored: number;
  ratio: number;
} {
  let reviews = 0;
  let authored = 0;
  for (const rel of rels) {
    if (rel.type === 'reviewed_by') reviews++;
    else if (rel.type === 'authored_by') authored++;
  }
  const total = reviews + authored;
  return { reviews, authored, ratio: total > 0 ? reviews / total : 0 };
}

function filterByAge(rels: Relation[], now: Date, days: number): Relation[] {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return rels.filter((r) => r.createdAt >= cutoff);
}

function upsertPersonalityFact(
  ctx: PersonalityContext,
  entityName: string,
  properties: Record<string, unknown>,
  confidence: number,
  now: Date,
): 'created' | 'updated' {
  const { brain, actor } = ctx;

  const existing = brain.entities
    .findByName(entityName, 'personal')
    .filter((e) => e.name === entityName);

  if (existing.length > 0) {
    brain.entities.update(existing[0].id, { properties, confidence });
    return 'updated';
  }

  brain.entities.create({
    type: 'fact',
    name: entityName,
    namespace: 'personal',
    source: { type: 'personality', ref: 'management-signals', actor },
    properties,
    confidence,
    tags: ['personality', 'management-signals'],
    eventTime: now.toISOString(),
  });
  return 'created';
}

export default ManagementSignalsStream;
