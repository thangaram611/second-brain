import type { Entity, EntityType } from './entity.js';
import type { Relation } from './relation.js';

/** Options for bitemporal "as-of" queries */
export interface TemporalQueryOptions {
  /** Filter: "what was true as of this date" (event_time <= asOfEventTime) */
  asOfEventTime?: string;
  /** Filter: "what did we know as of this date" (ingest_time <= asOfIngestTime) */
  asOfIngestTime?: string;
  namespace?: string;
  types?: EntityType[];
  limit?: number;
  offset?: number;
}

/** A single timeline entry representing a knowledge change event */
export interface TimelineEntry {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  changeType: 'created' | 'updated';
  timestamp: string;
  confidence: number;
  namespace: string;
}

/** Options for the timeline query */
export interface TimelineOptions {
  from: string;
  to: string;
  namespace?: string;
  types?: EntityType[];
  limit?: number;
  offset?: number;
}

/** A contradiction pair: two entities linked by a 'contradicts' relation */
export interface Contradiction {
  relation: Relation;
  entityA: Entity;
  entityB: Entity;
}

/** Options for finding stale entities */
export interface StaleEntityOptions {
  /** Confidence threshold — entities with effective confidence below this are stale. Default: 0.5 */
  threshold?: number;
  namespace?: string;
  types?: EntityType[];
  limit?: number;
  offset?: number;
}

/** Configuration for the decay engine */
export interface DecayEngineConfig {
  /** Interval in milliseconds between decay runs. Default: 3_600_000 (1 hour) */
  intervalMs?: number;
  /** If true, run one decay pass immediately on start. Default: false */
  runImmediately?: boolean;
}

/** Result of a single decay run */
export interface DecayRunResult {
  staleCount: number;
  runDurationMs: number;
  timestamp: string;
}
