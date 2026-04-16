import type { Entity, Relation, SearchResult } from '@second-brain/types';
import type { Brain } from '@second-brain/core';

// ── MCP response helpers ────────────────────────────────────────────

export function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

export function errorResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

export function notFoundResponse(type: string, id: string) {
  return errorResponse(`${type} not found: ${id}`);
}

// ── Search result formatters ────────────────────────────────────────

/** Generic search result → markdown used by search_brain. */
export function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((r) => {
      const e = r.entity;
      const lines = [
        `[${e.type}] ${e.name} (score: ${r.score.toFixed(3)}, confidence: ${e.confidence})`,
        `  id: ${e.id}`,
      ];
      if (e.observations.length > 0) {
        for (const obs of e.observations) {
          lines.push(`  - ${obs}`);
        }
      }
      if (e.tags.length > 0) {
        lines.push(`  tags: ${e.tags.join(', ')}`);
      }
      lines.push(`  namespace: ${e.namespace}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Decision-oriented search result → markdown. */
export function formatDecisionResults(results: SearchResult[]): string {
  return results
    .map((r) => {
      const e = r.entity;
      const lines = [`**${e.name}** (confidence: ${e.confidence})`];
      for (const obs of e.observations) {
        lines.push(`  - ${obs}`);
      }
      lines.push(`  id: ${e.id} | namespace: ${e.namespace} | created: ${e.createdAt}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Pattern-oriented search result → markdown. */
export function formatPatternResults(results: SearchResult[]): string {
  return results
    .map((r) => {
      const e = r.entity;
      const lines = [`**${e.name}** (confidence: ${e.confidence})`];
      for (const obs of e.observations) {
        lines.push(`  - ${obs}`);
      }
      lines.push(`  id: ${e.id} | namespace: ${e.namespace}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ── Entity detail formatter ─────────────────────────────────────────

/** Full entity detail with relations, used by get_entity. */
export function formatEntityDetail(
  entity: Entity,
  outbound: Relation[],
  inbound: Relation[],
  brain: Brain,
): string {
  const lines = [
    `# ${entity.name}`,
    `Type: ${entity.type}`,
    `ID: ${entity.id}`,
    `Namespace: ${entity.namespace}`,
    `Confidence: ${entity.confidence}`,
    `Access count: ${entity.accessCount}`,
    `Source: ${entity.source.type}${entity.source.ref ? ` (${entity.source.ref})` : ''}`,
    `Created: ${entity.createdAt}`,
    `Updated: ${entity.updatedAt}`,
  ];

  if (entity.observations.length > 0) {
    lines.push('', '## Observations');
    for (const obs of entity.observations) {
      lines.push(`- ${obs}`);
    }
  }

  if (entity.tags.length > 0) {
    lines.push('', `## Tags`, entity.tags.join(', '));
  }

  if (Object.keys(entity.properties).length > 0) {
    lines.push('', '## Properties', JSON.stringify(entity.properties, null, 2));
  }

  if (outbound.length > 0) {
    lines.push('', '## Outbound Relations');
    for (const rel of outbound) {
      const target = brain.entities.get(rel.targetId);
      lines.push(`- ${rel.type} → ${target?.name ?? rel.targetId} (weight: ${rel.weight})`);
    }
  }

  if (inbound.length > 0) {
    lines.push('', '## Inbound Relations');
    for (const rel of inbound) {
      const source = brain.entities.get(rel.sourceId);
      lines.push(`- ${source?.name ?? rel.sourceId} → ${rel.type} (weight: ${rel.weight})`);
    }
  }

  return lines.join('\n');
}
