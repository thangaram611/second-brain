import type { PendingRelation } from '@second-brain/ingestion';
import type { EntitySource } from '@second-brain/types';

/**
 * Tracks file co-changes across commits and produces weighted
 * co_changes_with relations for files that frequently change together.
 */
export class CoChangeTracker {
  /** Map of "fileA\0fileB" (sorted) -> co-change count */
  private counts = new Map<string, number>();

  /** Record that a set of files changed together in one commit */
  recordCommit(filePaths: string[]): void {
    // Generate all unique pairs
    for (let i = 0; i < filePaths.length; i++) {
      for (let j = i + 1; j < filePaths.length; j++) {
        const pair = [filePaths[i], filePaths[j]].sort();
        const key = pair.join('\0');
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
    }
  }

  /** Produce co_changes_with relations for pairs changed together >= minCount times */
  toRelations(source: EntitySource, namespace?: string, minCount = 2): PendingRelation[] {
    const relations: PendingRelation[] = [];

    for (const [key, count] of this.counts) {
      if (count < minCount) continue;

      const [fileA, fileB] = key.split('\0');
      relations.push({
        type: 'co_changes_with',
        sourceName: fileA,
        sourceType: 'file',
        targetName: fileB,
        targetType: 'file',
        weight: Math.min(1.0, count / 10),
        bidirectional: true,
        source,
        namespace,
      });
    }

    return relations;
  }
}
