import type { EntitySource } from './entity.js';

export const RELATION_TYPES = [
  'relates_to',
  'depends_on',
  'implements',
  'supersedes',
  'contradicts',
  'derived_from',
  'authored_by',
  'decided_in',
  'uses',
  'tests',
  'contains',
  'co_changes_with',
  'preceded_by',
  'blocks',
  'reviewed_by',
  'merged_in_mr',
  'merged_in_pr',
  'touches_file',
  'owns',
  'parallel_with',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export interface Relation {
  id: string;
  type: RelationType;
  sourceId: string;
  targetId: string;
  namespace: string;
  properties: Record<string, unknown>;
  confidence: number;
  weight: number;
  bidirectional: boolean;
  source: EntitySource;
  eventTime: string;
  ingestTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRelationInput {
  type: RelationType;
  sourceId: string;
  targetId: string;
  namespace?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  weight?: number;
  bidirectional?: boolean;
  source: EntitySource;
  eventTime?: string;
}

export interface UpdateRelationInput {
  namespace?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  weight?: number;
  bidirectional?: boolean;
}
