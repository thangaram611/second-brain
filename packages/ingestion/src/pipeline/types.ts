import type { CreateEntityInput, EntityType, RelationType, EntitySource } from '@second-brain/types';

/** Result of a single collection + extraction pass */
export interface ExtractionResult {
  entities: CreateEntityInput[];
  /** Relations reference entity names, not IDs (resolved after entities are upserted) */
  relations: PendingRelation[];
}

/**
 * A relation with name-based references instead of IDs.
 * Resolved to CreateRelationInput after entities exist in the brain.
 */
export interface PendingRelation {
  type: RelationType;
  sourceName: string;
  sourceType: EntityType;
  targetName: string;
  targetType: EntityType;
  namespace?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  weight?: number;
  bidirectional?: boolean;
  source: EntitySource;
  eventTime?: string;
}

/** Progress event emitted during pipeline execution */
export interface PipelineProgress {
  stage: 'collecting' | 'resolving' | 'storing' | 'done';
  collector?: string;
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: PipelineProgress) => void;

/** Configuration shared across pipeline components */
export interface PipelineConfig {
  namespace: string;
  repoPath: string;
  ignorePatterns: string[];
  onProgress?: ProgressCallback;
}

/** A collector gathers raw data and produces extraction results */
export interface Collector {
  readonly name: string;
  collect(config: PipelineConfig): Promise<ExtractionResult>;
}

/** Summary returned after a pipeline run */
export interface PipelineRunSummary {
  entitiesCreated: number;
  relationsCreated: number;
  relationsSkipped: number;
  errors: Array<{ collector: string; message: string }>;
  durationMs: number;
}
