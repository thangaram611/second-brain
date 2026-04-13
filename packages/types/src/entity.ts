export const ENTITY_TYPES = [
  'concept',
  'decision',
  'pattern',
  'person',
  'file',
  'symbol',
  'event',
  'tool',
  'fact',
  'conversation',
  'reference',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface EntitySource {
  type: 'git' | 'ast' | 'conversation' | 'github' | 'gitlab' | 'manual' | 'doc' | 'inferred';
  ref?: string;
  actor?: string;
}

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  namespace: string;
  observations: string[];
  properties: Record<string, unknown>;
  confidence: number;
  eventTime: string;
  ingestTime: string;
  lastAccessedAt: string;
  accessCount: number;
  source: EntitySource;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateEntityInput {
  type: EntityType;
  name: string;
  namespace?: string;
  observations?: string[];
  properties?: Record<string, unknown>;
  confidence?: number;
  eventTime?: string;
  source: EntitySource;
  tags?: string[];
}

export interface UpdateEntityInput {
  name?: string;
  observations?: string[];
  properties?: Record<string, unknown>;
  confidence?: number;
  tags?: string[];
}

/** Confidence decay rates per entity type (per day) */
export const DECAY_RATES: Record<EntityType, number> = {
  concept: 0.001,
  decision: 0.005,
  pattern: 0.003,
  person: 0.0,
  file: 0.0,
  symbol: 0.0,
  event: 0.02,
  tool: 0.001,
  fact: 0.01,
  conversation: 0.05,
  reference: 0.001,
};
