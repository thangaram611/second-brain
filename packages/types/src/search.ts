import type { Entity } from './entity.js';
import type { EntityType } from './entity.js';
import type { RelationType } from './relation.js';

export type SearchChannel = 'fulltext' | 'vector' | 'graph';

export interface SearchOptions {
  query: string;
  namespace?: string;
  types?: EntityType[];
  limit?: number;
  offset?: number;
  channels?: SearchChannel[];
  minConfidence?: number;
}

export interface SearchResult {
  entity: Entity;
  score: number;
  matchChannel: SearchChannel;
  highlights?: string[];
}

export interface GraphTraversalOptions {
  seedId: string;
  depth?: number;
  relationTypes?: RelationType[];
  entityTypes?: EntityType[];
  namespace?: string;
  maxResults?: number;
}

export interface GraphStats {
  totalEntities: number;
  totalRelations: number;
  entitiesByType: Record<string, number>;
  relationsByType: Record<string, number>;
  namespaces: string[];
}
