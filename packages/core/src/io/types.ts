import type { EntityType } from '@second-brain/types';

export type ExportFormat = 'json' | 'json-ld' | 'dot';

export interface ExportOptions {
  format: ExportFormat;
  namespace?: string;
  types?: EntityType[];
  includeRelations?: boolean;
}

export interface ImportOptions {
  format: 'json' | 'json-ld';
  strategy: 'replace' | 'merge' | 'upsert';
  namespace?: string;
}

export interface ImportResult {
  entitiesImported: number;
  relationsImported: number;
  conflicts: ImportConflict[];
}

export interface ImportConflict {
  entityName: string;
  entityType: string;
  existingId?: string;
  reason: string;
}
