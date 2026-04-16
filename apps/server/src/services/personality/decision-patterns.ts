import { createHash } from 'node:crypto';
import type { Entity } from '@second-brain/types';
import { rawRowToEntity } from '@second-brain/core';
import type { PersonalityStream, PersonalityContext } from '../personality-extractor.js';
import { containsVerbatim } from './verbatim-guard.js';

const STREAM_NAME = 'decision-patterns';
const MIN_DECISIONS = 5;
const QUERY_LIMIT = 200;
const CLUSTER_SIZE = 8;
const MAX_RELATIONS_PER_PATTERN = 10;

const systemPrompt = `You are analyzing developer decision-making patterns. Given a set of technical decisions, identify the recurring pattern or principle. Output a concise 1-2 sentence summary of the pattern. Do NOT quote or reproduce the original decisions verbatim. Synthesize and abstract.`;

const stricterSystemPrompt = `You are analyzing developer decision-making patterns. Given a set of technical decisions, identify the recurring pattern or principle. Output a concise 1-2 sentence ABSTRACT summary. You MUST NOT use any phrases, words sequences, or sentence fragments from the input. Rephrase everything in your own words.`;

function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function signatureFromIds(ids: string[]): string {
  const hash = createHash('sha256');
  for (const id of ids) hash.update(id);
  return hash.digest('hex').slice(0, 12);
}

function stripFilePaths(text: string): string {
  return text.replace(/(?:\/[\w./-]+|[A-Za-z]:\\[\w.\\/-]+)/g, '<path>');
}

function buildUserPrompt(decisions: Entity[]): string {
  const lines = decisions.map(
    (d, i) => `${i + 1}. ${stripFilePaths(d.observations.join(' '))}`,
  );
  return `Here are ${decisions.length} recent technical decisions by this developer:\n\n${lines.join('\n')}\n\nWhat recurring decision-making pattern do you see?`;
}

export const decisionPatternsStream: PersonalityStream = {
  name: STREAM_NAME,

  async run(ctx: PersonalityContext): Promise<{ created: number; updated: number }> {
    const { brain, actor, llm, logger } = ctx;

    const rows = brain.storage.sqlite
      .prepare(
        `SELECT * FROM entities
         WHERE source_actor = ? AND namespace != 'personal' AND type = 'decision'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(actor, QUERY_LIMIT) as Record<string, unknown>[];

    const decisions = rows.map((r) => rawRowToEntity(r));

    if (decisions.length < MIN_DECISIONS) {
      logger.info(`[${STREAM_NAME}] only ${decisions.length} decisions — skipping`);
      return { created: 0, updated: 0 };
    }

    if (llm == null) {
      logger.info(`[${STREAM_NAME}] no LLM available — skipping`);
      return { created: 0, updated: 0 };
    }

    const clusters = chunkArray(decisions, CLUSTER_SIZE).filter(
      (c) => c.length >= MIN_DECISIONS,
    );

    let created = 0;

    for (const cluster of clusters) {
      const sourceTexts = cluster.flatMap((d) => d.observations);
      const userPrompt = buildUserPrompt(cluster);

      let output = await llm.generate(userPrompt, systemPrompt);

      if (containsVerbatim(output, sourceTexts)) {
        logger.warn(`[${STREAM_NAME}] verbatim detected — regenerating with stricter prompt`);
        output = await llm.generate(userPrompt, stricterSystemPrompt);

        if (containsVerbatim(output, sourceTexts)) {
          logger.warn(`[${STREAM_NAME}] still verbatim after retry — dropping cluster`);
          continue;
        }
      }

      const clusterIds = cluster.map((d) => d.id);
      const signature = signatureFromIds(clusterIds);

      const entity = brain.entities.create({
        type: 'pattern',
        name: `decision-pattern:${signature}`,
        namespace: 'personal',
        source: { type: 'personality', ref: STREAM_NAME, actor },
        observations: [output],
        properties: {
          summary: output,
          decisionCount: cluster.length,
          sourceDecisionIds: clusterIds,
        },
        confidence: Math.min(cluster.length / 10, 1.0),
        tags: ['personality', 'decision-patterns'],
      });

      const relIds = clusterIds.slice(0, MAX_RELATIONS_PER_PATTERN);
      for (const targetId of relIds) {
        brain.relations.create({
          type: 'derived_from',
          sourceId: entity.id,
          targetId,
          namespace: 'personal',
          source: { type: 'personality', ref: STREAM_NAME, actor },
          confidence: 1.0,
        });
      }

      created++;
    }

    return { created, updated: 0 };
  },
};
