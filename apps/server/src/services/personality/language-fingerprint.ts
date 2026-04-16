import type { PersonalityStream, PersonalityContext } from '../personality-extractor.js';
import { rawRowToEntity } from '@second-brain/core';

/**
 * N-gram statistics over commit messages and MR/PR descriptions.
 * Pure computation — no LLM required.
 */
export class LanguageFingerprintStream implements PersonalityStream {
  readonly name = 'language-fingerprint';

  async run(ctx: PersonalityContext): Promise<{ created: number; updated: number }> {
    const { brain, actor, logger, now } = ctx;

    // Query MR/PR entities authored by actor in non-personal namespaces
    const rows = brain.storage.sqlite
      .prepare(
        `SELECT * FROM entities
         WHERE source_actor = ?
           AND namespace != 'personal'
           AND type IN ('merge_request', 'pull_request')`,
      )
      .all(actor) as Record<string, unknown>[];

    if (rows.length === 0) {
      logger.info(`[language-fingerprint] no MR/PR entities for actor=${actor}`);
      return { created: 0, updated: 0 };
    }

    const entities = rows.map(rawRowToEntity);

    // Group observations by namespace
    const byNamespace = new Map<string, { observations: string[]; count: number }>();
    for (const entity of entities) {
      const ns = entity.namespace;
      const bucket = byNamespace.get(ns) ?? { observations: [], count: 0 };
      bucket.observations.push(...entity.observations);
      bucket.count += 1;
      byNamespace.set(ns, bucket);
    }

    let created = 0;
    let updated = 0;

    for (const [namespace, { observations, count }] of byNamespace) {
      const tokens = tokenize(observations.join(' '));
      if (tokens.length < 2) continue;

      const bigrams = buildNgrams(tokens, 2);
      const trigrams = buildNgrams(tokens, 3);

      const top50Bigrams = topN(bigrams, 50);
      const top50Trigrams = topN(trigrams, 50);

      const entityName = `language-fingerprint:${namespace}`;
      const props = {
        targetNamespace: namespace,
        bigrams: top50Bigrams,
        trigrams: top50Trigrams,
        totalTokens: tokens.length,
        sampleSize: count,
      };
      const confidence = Math.min(count / 20, 1.0);

      const result = upsertPersonalityFact(ctx, entityName, props, confidence, now);
      if (result === 'created') created++;
      else updated++;
    }

    return { created, updated };
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function buildNgrams(tokens: string[], n: number): Map<string, number> {
  const freq = new Map<string, number>();
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join(' ');
    freq.set(gram, (freq.get(gram) ?? 0) + 1);
  }
  return freq;
}

function topN(freq: Map<string, number>, n: number): Array<[string, number]> {
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function upsertPersonalityFact(
  ctx: PersonalityContext,
  entityName: string,
  properties: Record<string, unknown>,
  confidence: number,
  now: Date,
): 'created' | 'updated' {
  const { brain, actor } = ctx;

  // findByName uses LIKE %...% — filter to exact match
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
    source: { type: 'personality', ref: 'language-fingerprint', actor },
    properties,
    confidence,
    tags: ['personality', 'language-fingerprint'],
    eventTime: now.toISOString(),
  });
  return 'created';
}

export default LanguageFingerprintStream;
