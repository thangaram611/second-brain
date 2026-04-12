import { z } from 'zod';
import { ENTITY_TYPES, RELATION_TYPES } from '@second-brain/types';

const entityTypeEnum = z.enum(ENTITY_TYPES);
const relationTypeEnum = z.enum(RELATION_TYPES);

export const CreateEntitySchema = z.object({
  type: entityTypeEnum,
  name: z.string().min(1),
  observations: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  namespace: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const UpdateEntitySchema = z.object({
  name: z.string().min(1).optional(),
  observations: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const ObservationSchema = z.object({
  observation: z.string().min(1),
});

export const CreateRelationSchema = z.object({
  type: relationTypeEnum,
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  namespace: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  weight: z.number().min(0).max(1).optional(),
  bidirectional: z.boolean().optional(),
});

export const SearchQuerySchema = z.object({
  q: z.string().min(1),
  namespace: z.string().optional(),
  types: z.string().optional(), // comma-separated entity types
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
});

export const ListQuerySchema = z.object({
  namespace: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const NeighborsQuerySchema = z.object({
  depth: z.coerce.number().int().positive().max(5).optional(),
  relationTypes: z.string().optional(), // comma-separated
});

// --- Temporal schemas (Phase 5) ---

export const TimelineQuerySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  namespace: z.string().optional(),
  types: z.string().optional(), // comma-separated
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const ContradictionsQuerySchema = z.object({
  namespace: z.string().optional(),
});

export const ResolveContradictionSchema = z.object({
  winnerId: z.string().min(1),
});

export const StaleQuerySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).optional(),
  namespace: z.string().optional(),
  types: z.string().optional(), // comma-separated
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const DecisionLogQuerySchema = z.object({
  namespace: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['newest', 'oldest', 'confidence']).optional(),
});

export const TemporalEntityQuerySchema = z.object({
  asOfEventTime: z.string().optional(),
  asOfIngestTime: z.string().optional(),
  namespace: z.string().optional(),
  types: z.string().optional(), // comma-separated
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
