import { generateObject } from 'ai';
import { z } from 'zod';
import {
  ENTITY_TYPES,
  RELATION_TYPES,
  type EntitySource,
  type CreateEntityInput,
} from '@second-brain/types';
import type { LanguageModel } from 'ai';
import type { LLMConfig } from './llm-config.js';
import type { ExtractionResult, PendingRelation } from '../pipeline/types.js';
import { resolveChatModel } from './model-resolver.js';

/**
 * Zod schema for what the LLM is asked to return.
 * Constrains entity/relation types to the canonical enums so PendingRelation
 * resolution downstream works without runtime surprises.
 */
const ExtractedEntitySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  name: z.string().min(1).max(200),
  observations: z.array(z.string().min(1).max(2000)).max(20).optional(),
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ExtractedRelationSchema = z.object({
  type: z.enum(RELATION_TYPES),
  sourceName: z.string().min(1),
  sourceType: z.enum(ENTITY_TYPES),
  targetName: z.string().min(1),
  targetType: z.enum(ENTITY_TYPES),
  confidence: z.number().min(0).max(1).optional(),
});

const ExtractionSchema = z.object({
  entities: z.array(ExtractedEntitySchema).max(50),
  relations: z.array(ExtractedRelationSchema).max(50),
});

export type ExtractedShape = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You are a knowledge extraction engine for a developer's personal knowledge graph.

Given a piece of text, identify durable, reusable knowledge worth remembering across sessions:
- DECISIONS made and the reasoning behind them
- FACTS learned (technical claims, API limits, behavior, constraints)
- PATTERNS recurring approaches or solutions
- CONCEPTS new abstractions or ideas
- TOOLS, LIBRARIES, FRAMEWORKS used or evaluated
- PEOPLE with notable roles or contributions

Skip ephemeral chat, social pleasantries, or session-specific noise.

For each entity:
- Choose the most specific type from: ${ENTITY_TYPES.join(', ')}
- name: short, identifiable, reusable across mentions
- observations: atomic facts, ONE per array entry (not paragraphs)

For each relation, both endpoints must reference entities you also extracted (by name + type).
Use relation types: ${RELATION_TYPES.join(', ')}

Return ONLY JSON conforming to the provided schema. No prose.`;

export interface ExtractContext {
  /** Namespace for created entities. Defaults to 'personal'. */
  namespace?: string;
  /** Source attribution used on every created entity/relation. */
  source: EntitySource;
}

export interface LLMExtractorOptions {
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Override model resolution (e.g. for tests). */
  model?: LanguageModel;
  /** Maximum input characters per call. Truncates to keep prompts bounded. Default 24000. */
  maxInputChars?: number;
}

/**
 * LLM-based extractor: text → ExtractionResult (entities + name-based pending relations).
 *
 * The result feeds directly into PipelineRunner — relations are name-based
 * and resolved to IDs after batch upsert.
 */
export class LLMExtractor {
  private readonly model: LanguageModel;
  private readonly systemPrompt: string;
  private readonly maxInputChars: number;

  constructor(config: LLMConfig, options: LLMExtractorOptions = {}) {
    this.model = options.model ?? resolveChatModel(config);
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.maxInputChars = options.maxInputChars ?? 24_000;
  }

  /**
   * Run extraction on a single text payload.
   * Truncates the input if necessary; LLM is free to extract zero entities.
   */
  async extract(text: string, context: ExtractContext): Promise<ExtractionResult> {
    const trimmed = text.length > this.maxInputChars ? text.slice(0, this.maxInputChars) : text;
    if (!trimmed.trim()) return { entities: [], relations: [] };

    const { object } = await generateObject({
      model: this.model,
      schema: ExtractionSchema,
      system: this.systemPrompt,
      prompt: trimmed,
    });

    return shapeToResult(object, context);
  }
}

/** Convert the validated LLM output into pipeline-shaped entities + relations. */
function shapeToResult(shape: ExtractedShape, context: ExtractContext): ExtractionResult {
  const namespace = context.namespace ?? 'personal';
  const source = context.source;

  const entities: CreateEntityInput[] = shape.entities.map((e) => ({
    type: e.type,
    name: e.name.trim(),
    namespace,
    observations: e.observations?.map((o) => o.trim()).filter(Boolean) ?? [],
    tags: e.tags?.map((t) => t.trim()).filter(Boolean) ?? [],
    confidence: e.confidence,
    source,
  }));

  // Index extracted entity names so we can drop relations whose endpoints
  // weren't actually emitted by the LLM (defensive — schema guarantees the
  // type set but not name presence).
  const nameKey = (name: string, type: string) => `${type}::${name.trim().toLowerCase()}`;
  const known = new Set(entities.map((e) => nameKey(e.name, e.type)));

  const relations: PendingRelation[] = shape.relations
    .filter(
      (r) =>
        known.has(nameKey(r.sourceName, r.sourceType)) &&
        known.has(nameKey(r.targetName, r.targetType)),
    )
    .map((r) => ({
      type: r.type,
      sourceName: r.sourceName.trim(),
      sourceType: r.sourceType,
      targetName: r.targetName.trim(),
      targetType: r.targetType,
      namespace,
      confidence: r.confidence,
      source,
    }));

  return { entities, relations };
}
