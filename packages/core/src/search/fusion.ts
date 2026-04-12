import type { Entity, SearchChannel, SearchResult } from '@second-brain/types';

const RRF_K = 60;

export interface RankedResult {
  entityId: string;
  entity: Entity;
  rank: number;
  channel: SearchChannel;
  channelScore: number;
}

/**
 * Reciprocal Rank Fusion: merges ranked result lists from multiple search channels.
 * Each entity's score = sum of 1/(K + rank) across all channels it appears in.
 */
export function reciprocalRankFusion(
  resultLists: ReadonlyArray<ReadonlyArray<RankedResult>>,
): SearchResult[] {
  const scores = new Map<
    string,
    { entity: Entity; score: number; bestChannel: SearchChannel }
  >();

  for (const list of resultLists) {
    for (const result of list) {
      const rrfScore = 1 / (RRF_K + result.rank);
      const existing = scores.get(result.entityId);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(result.entityId, {
          entity: result.entity,
          score: rrfScore,
          bestChannel: result.channel,
        });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ entity, score, bestChannel }) => ({
      entity,
      score,
      matchChannel: bestChannel,
    }));
}
