import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brain } from '@second-brain/core';
import { ENTITY_TYPES, RELATION_TYPES, sessionNamespace } from '@second-brain/types';
import type { EntityType, RelationType, TimelineEntry, SearchResult } from '@second-brain/types';
import {
  textResponse,
  notFoundResponse,
  formatSearchResults,
  formatDecisionResults,
  formatPatternResults,
  formatEntityDetail,
} from './formatters.js';

export interface RecallContextBlockOptions {
  query?: string;
  namespaces?: string[];
  limit?: number;
  /** When true, prepend a <parallel-work-alert> block if any collisions exist. */
  includeParallelWork?: boolean;
}

/**
 * Build a compact markdown context block summarizing entities relevant to the
 * current session. Safe to call without a query — falls back to recently
 * accessed entities in the requested namespaces.
 */
export async function buildRecallContextBlock(
  brain: Brain,
  options: RecallContextBlockOptions,
): Promise<string> {
  const limit = options.limit ?? 15;
  const namespaces = options.namespaces && options.namespaces.length > 0
    ? options.namespaces
    : ['personal'];

  let hits: SearchResult[] = [];
  if (options.query && options.query.trim()) {
    const perNs = Math.ceil(limit * 1.5);
    for (const ns of namespaces) {
      const res = await brain.search.searchMulti({
        query: options.query,
        namespace: ns,
        limit: perNs,
      });
      hits.push(...res);
    }
    // Dedupe by id, keep highest score.
    const byId = new Map<string, SearchResult>();
    for (const h of hits) {
      const prev = byId.get(h.entity.id);
      if (!prev || h.score > prev.score) byId.set(h.entity.id, h);
    }
    hits = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  } else {
    // No query — surface most recently accessed entities across scoped namespaces.
    const recent: SearchResult[] = [];
    for (const ns of namespaces) {
      const list = brain.entities.list({ namespace: ns, limit: limit * 2 });
      list.sort(
        (a, b) =>
          new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
      );
      for (const entity of list.slice(0, limit)) {
        recent.push({ entity, score: entity.confidence, matchChannel: 'fulltext' });
      }
    }
    hits = recent.slice(0, limit);
  }

  const alertLines: string[] = [];
  if (options.includeParallelWork) {
    const collisions = brain.findParallelWork({ limit: 10 });
    if (collisions.length > 0) {
      alertLines.push('<parallel-work-alert>');
      for (const c of collisions) {
        alertLines.push(`  ${c.entityType}: ${c.entityName} (ns=${c.namespace})`);
        alertLines.push(`    actors:   ${c.actors.join(', ')}`);
        alertLines.push(`    branches: ${c.branches.join(', ')}`);
      }
      alertLines.push('</parallel-work-alert>');
    }
  }

  if (hits.length === 0) {
    return alertLines.length > 0 ? alertLines.join('\n') : '';
  }

  const lines: string[] = [];
  if (alertLines.length > 0) {
    lines.push(...alertLines, '');
  }
  lines.push('## Prior context from second-brain');
  for (const h of hits) {
    const e = h.entity;
    lines.push(`- [${e.type}] **${e.name}** · ${e.id} · ns=${e.namespace}`);
    if (e.observations.length > 0) {
      lines.push(`  - ${e.observations[0]}`);
    }
  }
  return lines.join('\n');
}

export function registerReadTools(mcp: McpServer, brain: Brain): void {
  // --- search_brain ---
  mcp.registerTool('search_brain', {
    description:
      'Search the knowledge graph using full-text search. Primary entry point for finding entities by name, observations, or tags.',
    inputSchema: {
      query: z.string().describe('Search query text'),
      namespace: z.string().optional().describe('Filter by namespace (e.g. "personal", project ID)'),
      types: z
        .array(z.enum(ENTITY_TYPES))
        .optional()
        .describe('Filter by entity types'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const results = brain.search.search({
      query: args.query,
      namespace: args.namespace,
      types: args.types as EntityType[] | undefined,
      limit: args.limit ?? 20,
      minConfidence: args.minConfidence,
    });

    if (results.length === 0) {
      return textResponse('No results found.');
    }

    return textResponse(`Found ${results.length} result(s):\n\n${formatSearchResults(results)}`);
  });

  // --- get_entity ---
  mcp.registerTool('get_entity', {
    description:
      'Get a specific entity by ID with all its observations, tags, properties, and connected relations.',
    inputSchema: {
      id: z.string().describe('Entity ID (ULID)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const entity = brain.entities.get(args.id);
    if (!entity) {
      return notFoundResponse('Entity', args.id);
    }

    // Touch to track access
    brain.entities.touch(args.id);

    const outbound = brain.relations.getOutbound(args.id);
    const inbound = brain.relations.getInbound(args.id);

    return textResponse(formatEntityDetail(entity, outbound, inbound, brain));
  });

  // --- get_neighbors ---
  mcp.registerTool('get_neighbors', {
    description:
      'Get entities connected to a given entity via relations. Supports depth control for multi-hop traversal.',
    inputSchema: {
      entityId: z.string().describe('Starting entity ID'),
      depth: z.number().int().min(1).max(5).optional().describe('Traversal depth (default 1, max 5)'),
      relationTypes: z
        .array(z.enum(RELATION_TYPES))
        .optional()
        .describe('Filter by relation types'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const seed = brain.entities.get(args.entityId);
    if (!seed) {
      return notFoundResponse('Entity', args.entityId);
    }

    const { entities: neighbors, relations } = brain.traversal.getNeighbors(
      args.entityId,
      args.depth ?? 1,
      args.relationTypes as RelationType[] | undefined,
    );

    if (neighbors.length === 0) {
      return textResponse(`No neighbors found for "${seed.name}".`);
    }

    const lines = [`Neighbors of "${seed.name}" (depth ${args.depth ?? 1}):\n`];

    for (const entity of neighbors) {
      lines.push(`[${entity.type}] ${entity.name} (${entity.id})`);
      if (entity.observations.length > 0) {
        lines.push(`  ${entity.observations[0]}`);
      }
    }

    lines.push('', `Relations (${relations.length}):`);
    for (const rel of relations) {
      const src = rel.sourceId === args.entityId ? seed.name : neighbors.find((e) => e.id === rel.sourceId)?.name ?? rel.sourceId;
      const tgt = rel.targetId === args.entityId ? seed.name : neighbors.find((e) => e.id === rel.targetId)?.name ?? rel.targetId;
      lines.push(`  ${src} --[${rel.type}]--> ${tgt}`);
    }

    return textResponse(lines.join('\n'));
  });

  // --- traverse_graph ---
  mcp.registerTool('traverse_graph', {
    description:
      'Find paths between two entities in the knowledge graph. Returns all paths up to maxDepth hops.',
    inputSchema: {
      fromId: z.string().describe('Starting entity ID'),
      toId: z.string().describe('Target entity ID'),
      maxDepth: z.number().int().min(1).max(10).optional().describe('Maximum path length (default 5)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const from = brain.entities.get(args.fromId);
    if (!from) {
      return notFoundResponse('Source entity', args.fromId);
    }
    const to = brain.entities.get(args.toId);
    if (!to) {
      return notFoundResponse('Target entity', args.toId);
    }

    const paths = brain.traversal.findPath(args.fromId, args.toId, args.maxDepth ?? 5);

    if (paths.length === 0) {
      return textResponse(`No path found between "${from.name}" and "${to.name}".`);
    }

    const lines = [`Found ${paths.length} path(s) from "${from.name}" to "${to.name}":\n`];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const steps: string[] = [from.name];
      let currentId = args.fromId;
      for (const rel of path) {
        const nextId = rel.sourceId === currentId ? rel.targetId : rel.sourceId;
        const nextEntity = brain.entities.get(nextId);
        steps.push(`--[${rel.type}]-->`);
        steps.push(nextEntity?.name ?? nextId);
        currentId = nextId;
      }
      lines.push(`  Path ${i + 1}: ${steps.join(' ')}`);
    }

    return textResponse(lines.join('\n'));
  });

  // --- search_decisions ---
  mcp.registerTool('search_decisions', {
    description: 'Find decision entities by topic. Shorthand for searching with type filter "decision".',
    inputSchema: {
      query: z.string().describe('Search query for decisions'),
      namespace: z.string().optional().describe('Filter by namespace'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const results = brain.search.search({
      query: args.query,
      namespace: args.namespace,
      types: ['decision'],
      limit: args.limit ?? 20,
    });

    if (results.length === 0) {
      return textResponse('No decisions found.');
    }

    return textResponse(`Found ${results.length} decision(s):\n\n${formatDecisionResults(results)}`);
  });

  // --- search_patterns ---
  mcp.registerTool('search_patterns', {
    description: 'Find recurring pattern entities by domain or technology.',
    inputSchema: {
      query: z.string().describe('Search query for patterns'),
      namespace: z.string().optional().describe('Filter by namespace'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const results = brain.search.search({
      query: args.query,
      namespace: args.namespace,
      types: ['pattern'],
      limit: args.limit ?? 20,
    });

    if (results.length === 0) {
      return textResponse('No patterns found.');
    }

    return textResponse(`Found ${results.length} pattern(s):\n\n${formatPatternResults(results)}`);
  });

  // --- get_graph_stats ---
  mcp.registerTool('get_graph_stats', {
    description: 'Get knowledge graph statistics: entity/relation counts, breakdown by type, namespaces.',
    inputSchema: {
      namespace: z.string().optional().describe('Filter stats by namespace'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const stats = brain.search.getStats(args.namespace);

    const lines = [
      `Entities: ${stats.totalEntities}`,
      `Relations: ${stats.totalRelations}`,
      `Namespaces: ${stats.namespaces.join(', ') || '(none)'}`,
    ];

    if (Object.keys(stats.entitiesByType).length > 0) {
      lines.push('', 'Entities by type:');
      for (const [type, count] of Object.entries(stats.entitiesByType)) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    if (Object.keys(stats.relationsByType).length > 0) {
      lines.push('', 'Relations by type:');
      for (const [type, count] of Object.entries(stats.relationsByType)) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    return textResponse(lines.join('\n'));
  });

  // --- get_contradictions ---
  mcp.registerTool('get_contradictions', {
    description:
      'List unresolved contradictions in the knowledge graph — entities linked by "contradicts" relations where neither has been superseded.',
    inputSchema: {
      namespace: z.string().optional().describe('Filter by namespace'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const contradictions = brain.contradictions.getUnresolved(args.namespace);

    if (contradictions.length === 0) {
      return textResponse('No unresolved contradictions.');
    }

    const text = contradictions
      .map((c, i) => {
        const lines = [
          `## Contradiction ${i + 1}`,
          `Relation ID: ${c.relation.id}`,
          ``,
          `**Entity A**: [${c.entityA.type}] ${c.entityA.name} (confidence: ${c.entityA.confidence})`,
        ];
        for (const obs of c.entityA.observations) {
          lines.push(`  - ${obs}`);
        }
        lines.push(`  id: ${c.entityA.id}`);
        lines.push(``);
        lines.push(`**Entity B**: [${c.entityB.type}] ${c.entityB.name} (confidence: ${c.entityB.confidence})`);
        for (const obs of c.entityB.observations) {
          lines.push(`  - ${obs}`);
        }
        lines.push(`  id: ${c.entityB.id}`);
        return lines.join('\n');
      })
      .join('\n\n---\n\n');

    return textResponse(`Found ${contradictions.length} unresolved contradiction(s):\n\n${text}`);
  });

  // --- get_timeline ---
  mcp.registerTool('get_timeline', {
    description:
      'View knowledge changes over a time range. Shows entities created or updated within the period.',
    inputSchema: {
      from: z.string().describe('Start of range (ISO 8601)'),
      to: z.string().describe('End of range (ISO 8601)'),
      namespace: z.string().optional().describe('Filter by namespace'),
      types: z
        .array(z.enum(ENTITY_TYPES))
        .optional()
        .describe('Filter by entity types'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 100)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const entries = brain.temporal.getTimeline({
      from: args.from,
      to: args.to,
      namespace: args.namespace,
      types: args.types as EntityType[] | undefined,
      limit: args.limit,
    });

    if (entries.length === 0) {
      return textResponse('No activity in this time range.');
    }

    // Group by date
    const grouped = new Map<string, TimelineEntry[]>();
    for (const entry of entries) {
      const date = entry.timestamp.split('T')[0];
      const group = grouped.get(date) ?? [];
      group.push(entry);
      grouped.set(date, group);
    }

    const lines: string[] = [`Timeline (${entries.length} event(s)):\n`];
    for (const [date, group] of grouped) {
      lines.push(`## ${date}`);
      for (const entry of group) {
        const tag = entry.changeType === 'created' ? '+' : '~';
        lines.push(`  ${tag} [${entry.entityType}] ${entry.entityName} (confidence: ${entry.confidence})`);
      }
      lines.push('');
    }

    return textResponse(lines.join('\n'));
  });

  // --- recall_session_context ---
  mcp.registerTool('recall_session_context', {
    description:
      'Surface memory relevant to the current session. Searches session:<id> (if given) and cross-session namespaces, merges hits, returns a compact context block. When includeParallelWork=true, prepends a <parallel-work-alert> block if another developer is editing overlapping entities on a different branch.',
    inputSchema: {
      sessionId: z.string().optional().describe('Active session ID; session:<id> is added to the namespace scope'),
      query: z.string().optional().describe('Optional free-text query. When absent, returns most-recently accessed entities.'),
      namespaces: z
        .array(z.string())
        .optional()
        .describe('Extra namespaces to include (default: ["personal"])'),
      limit: z.number().int().min(1).max(50).optional().describe('Max entities (default 15)'),
      includeParallelWork: z
        .boolean()
        .optional()
        .describe('Prepend a parallel-work-alert block when ≥2 actors touch the same entity on WIP branches. Default false.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const limit = args.limit ?? 15;
    const extra = args.namespaces ?? ['personal'];
    const scopeNamespaces = Array.from(
      new Set([
        ...(args.sessionId ? [sessionNamespace(args.sessionId)] : []),
        ...extra,
      ]),
    );

    const block = await buildRecallContextBlock(brain, {
      query: args.query,
      namespaces: scopeNamespaces,
      limit,
      includeParallelWork: args.includeParallelWork ?? false,
    });
    return textResponse(block || 'No prior context.');
  });

  // --- find_parallel_work ---
  mcp.registerTool('find_parallel_work', {
    description:
      'Surface entities touched by ≥2 distinct actors on WIP branches. Detects developer collisions (same file/symbol edited on different branches) BEFORE they become merge conflicts.',
    inputSchema: {
      branch: z.string().optional().describe('Limit to entities touched on this branch'),
      namespace: z.string().optional().describe('Filter to a namespace'),
      pathLike: z
        .string()
        .optional()
        .describe('Substring match on entity name (e.g. a file-path fragment)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const rows = brain.findParallelWork({
      branch: args.branch,
      namespace: args.namespace,
      pathLike: args.pathLike,
      limit: args.limit,
    });
    if (rows.length === 0) {
      return textResponse('No parallel work detected.');
    }
    const lines: string[] = ['Parallel work detected:', ''];
    for (const r of rows) {
      lines.push(`- [${r.entityType}] ${r.entityName} (ns=${r.namespace})`);
      lines.push(`    actors:   ${r.actors.join(', ')}`);
      lines.push(`    branches: ${r.branches.join(', ')}`);
    }
    return textResponse(lines.join('\n'));
  });

  // --- get_ownership ---
  mcp.registerTool('get_ownership', {
    description:
      'Compute file ownership scores. Returns ranked owners with signals (blame, commits, reviews, tests, CODEOWNERS). Useful for "who should review this?" or "who knows this code best?".',
    inputSchema: {
      path: z.string().describe('Repository-relative file path'),
      limit: z.number().int().min(1).max(50).optional().describe('Max owners to return (default 3)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const port = process.env.BRAIN_API_PORT ?? '7430';
    const url = new URL(`http://localhost:${port}/api/query/ownership`);
    url.searchParams.set('path', args.path);
    if (args.limit !== undefined) url.searchParams.set('limit', String(args.limit));

    const headers: Record<string, string> = {};
    const token = process.env.BRAIN_AUTH_TOKEN;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const text = await res.text();
      return { content: [{ type: 'text', text: `Ownership query failed (${res.status}): ${text}` }] };
    }

    const scores = (await res.json()) as Array<{ actor: string; score: number; signals: Record<string, unknown> }>;

    if (scores.length === 0) {
      return { content: [{ type: 'text', text: `No ownership data found for ${args.path}` }] };
    }

    const lines: string[] = [`Ownership for ${args.path}:`, ''];
    for (const s of scores) {
      lines.push(`- ${s.actor} (score: ${(s.score * 100).toFixed(1)}%)`);
      const sig = s.signals;
      lines.push(`    commits: ${sig.commits}, blame: ${sig.recencyWeightedBlameLines}, reviews: ${sig.reviews}, tests: ${sig.testAuthorship}, codeowner: ${sig.codeownerMatch}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  // --- timeline_around ---
  mcp.registerTool('timeline_around', {
    description:
      'Return entities whose eventTime falls within a window around a given anchor entity. Useful for "what else was happening when X was decided".',
    inputSchema: {
      entityId: z.string().describe('Anchor entity ID'),
      windowMinutes: z
        .number()
        .int()
        .positive()
        .max(60 * 24 * 14)
        .optional()
        .describe('Half-width of the window in minutes (default 60)'),
      namespace: z.string().optional().describe('Filter timeline to this namespace'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const anchor = brain.entities.get(args.entityId);
    if (!anchor) {
      return notFoundResponse('Entity', args.entityId);
    }
    const windowMinutes = args.windowMinutes ?? 60;
    const anchorMs = new Date(anchor.eventTime).getTime();
    const from = new Date(anchorMs - windowMinutes * 60_000).toISOString();
    const to = new Date(anchorMs + windowMinutes * 60_000).toISOString();

    const entries = brain.temporal.getTimeline({
      from,
      to,
      namespace: args.namespace ?? anchor.namespace,
      limit: 200,
    });

    if (entries.length === 0) {
      return textResponse(`No activity within ±${windowMinutes}min of "${anchor.name}".`);
    }

    const lines = [
      `Activity within ±${windowMinutes}min of [${anchor.type}] ${anchor.name}:`,
      '',
    ];
    for (const entry of entries) {
      if (entry.entityId === anchor.id) continue;
      const tag = entry.changeType === 'created' ? '+' : '~';
      lines.push(`  ${entry.timestamp}  ${tag} [${entry.entityType}] ${entry.entityName}  ${entry.entityId}`);
    }
    return textResponse(lines.join('\n'));
  });

  // --- get_observations_by_ids ---
  mcp.registerTool('get_observations_by_ids', {
    description:
      'Fetch full entity records for a set of IDs. Also bumps access count so decay is deferred for items the agent actually consulted.',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(100).describe('Entity IDs'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const rows: string[] = [];
    for (const id of args.ids) {
      const e = brain.entities.get(id);
      if (!e) {
        rows.push(`(missing) ${id}`);
        continue;
      }
      brain.entities.touch(id);
      const obsPreview = e.observations.slice(0, 6).map((o) => `  - ${o}`).join('\n');
      rows.push(
        [
          `[${e.type}] ${e.name}`,
          `  id: ${e.id}`,
          `  namespace: ${e.namespace}`,
          `  confidence: ${e.confidence}`,
          obsPreview,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    return textResponse(rows.join('\n\n'));
  });

  // --- get_stale ---
  mcp.registerTool('get_stale', {
    description:
      'Find entities with decayed confidence below a threshold. Confidence decays based on time since last access and entity type.',
    inputSchema: {
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Confidence threshold (default 0.5). Entities below this are stale.'),
      namespace: z.string().optional().describe('Filter by namespace'),
      types: z
        .array(z.enum(ENTITY_TYPES))
        .optional()
        .describe('Filter by entity types'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const stale = brain.decay.getStaleEntities({
      threshold: args.threshold,
      namespace: args.namespace,
      types: args.types as EntityType[] | undefined,
      limit: args.limit,
    });

    if (stale.length === 0) {
      return textResponse('No stale entities found.');
    }

    const text = stale
      .map((e) => {
        const lines = [
          `[${e.type}] ${e.name}`,
          `  id: ${e.id}`,
          `  base confidence: ${e.confidence} → effective: ${e.effectiveConfidence.toFixed(3)}`,
          `  last accessed: ${e.lastAccessedAt}`,
          `  namespace: ${e.namespace}`,
        ];
        return lines.join('\n');
      })
      .join('\n\n');

    return textResponse(`Found ${stale.length} stale entity(ies):\n\n${text}`);
  });
}
