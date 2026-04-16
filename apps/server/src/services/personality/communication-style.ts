import { z } from 'zod';
import { rawRowToEntity } from '@second-brain/core';
import type { PersonalityStream, PersonalityContext } from '../personality-extractor.js';
import { containsVerbatim } from './verbatim-guard.js';

const STREAM_NAME = 'communication-style';
const MIN_ENTITIES = 3;
const QUERY_LIMIT = 100;

const CommunicationStyleSchema = z.object({
  verbosity: z.enum(['concise', 'moderate', 'verbose']),
  formality: z.enum(['informal', 'neutral', 'formal']),
  humorMarkers: z.number().min(0).max(10),
});

const systemPrompt = `You are analyzing a developer's communication style based on their code review comments and merge request descriptions. Classify their style along these dimensions. Output ONLY valid JSON with no markdown formatting, code blocks, or extra text:
{
  "verbosity": "concise" | "moderate" | "verbose",
  "formality": "informal" | "neutral" | "formal",
  "humorMarkers": number  // 0-10 scale
}
Do NOT quote or reproduce the original text. Only classify.`;

export const communicationStyleStream: PersonalityStream = {
  name: STREAM_NAME,

  async run(ctx: PersonalityContext): Promise<{ created: number; updated: number }> {
    const { brain, actor, llm, logger } = ctx;

    const rows = brain.storage.sqlite
      .prepare(
        `SELECT * FROM entities
         WHERE source_actor = ? AND namespace != 'personal'
           AND type IN ('merge_request', 'pull_request', 'review')
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(actor, QUERY_LIMIT) as Record<string, unknown>[];

    const entities = rows.map((r) => rawRowToEntity(r));

    if (entities.length < MIN_ENTITIES) {
      logger.info(`[${STREAM_NAME}] only ${entities.length} entities — skipping`);
      return { created: 0, updated: 0 };
    }

    if (llm == null) {
      logger.info(`[${STREAM_NAME}] no LLM available — skipping`);
      return { created: 0, updated: 0 };
    }

    const allObservations = entities.flatMap((e) => e.observations);
    const proseSample = allObservations.join('\n\n');

    const userPrompt = `Here are ${entities.length} code review comments and merge request descriptions from this developer:\n\n${proseSample}\n\nClassify their communication style as JSON.`;

    const output = await llm.generate(userPrompt, systemPrompt);

    if (containsVerbatim(output, allObservations)) {
      logger.warn(`[${STREAM_NAME}] verbatim detected in LLM output — skipping`);
      return { created: 0, updated: 0 };
    }

    // Strip markdown code fences if present
    const cleaned = output.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();

    const parsed = CommunicationStyleSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success) {
      logger.warn(`[${STREAM_NAME}] failed to parse LLM output: ${parsed.error.message}`);
      return { created: 0, updated: 0 };
    }

    const style = parsed.data;

    // Group by namespace — produce one entity per namespace
    const namespaces = [...new Set(entities.map((e) => e.namespace))];
    let created = 0;

    for (const namespace of namespaces) {
      const nsEntities = entities.filter((e) => e.namespace === namespace);

      brain.entities.create({
        type: 'fact',
        name: `communication-style:${namespace}`,
        namespace: 'personal',
        source: { type: 'personality', ref: STREAM_NAME, actor },
        observations: [`verbosity=${style.verbosity} formality=${style.formality} humor=${style.humorMarkers}`],
        properties: {
          targetNamespace: namespace,
          verbosity: style.verbosity,
          formality: style.formality,
          humorMarkers: style.humorMarkers,
          sampleSize: nsEntities.length,
        },
        confidence: Math.min(nsEntities.length / 10, 1.0),
        tags: ['personality', 'communication-style'],
      });

      created++;
    }

    return { created, updated: 0 };
  },
};
