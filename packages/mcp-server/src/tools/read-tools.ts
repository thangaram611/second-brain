import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brain } from '@second-brain/core';
import { ENTITY_TYPES, RELATION_TYPES } from '@second-brain/types';
import type { EntityType, RelationType } from '@second-brain/types';

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
      return {
        content: [{ type: 'text', text: 'No results found.' }],
      };
    }

    const text = results
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

    return {
      content: [{ type: 'text', text: `Found ${results.length} result(s):\n\n${text}` }],
    };
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
      return {
        content: [{ type: 'text', text: `Entity not found: ${args.id}` }],
        isError: true,
      };
    }

    // Touch to track access
    brain.entities.touch(args.id);

    const outbound = brain.relations.getOutbound(args.id);
    const inbound = brain.relations.getInbound(args.id);

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

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
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
      return {
        content: [{ type: 'text', text: `Entity not found: ${args.entityId}` }],
        isError: true,
      };
    }

    const { entities: neighbors, relations } = brain.relations.getNeighbors(
      args.entityId,
      args.depth ?? 1,
      args.relationTypes as RelationType[] | undefined,
    );

    if (neighbors.length === 0) {
      return {
        content: [{ type: 'text', text: `No neighbors found for "${seed.name}".` }],
      };
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

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
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
      return {
        content: [{ type: 'text', text: `Source entity not found: ${args.fromId}` }],
        isError: true,
      };
    }
    const to = brain.entities.get(args.toId);
    if (!to) {
      return {
        content: [{ type: 'text', text: `Target entity not found: ${args.toId}` }],
        isError: true,
      };
    }

    const paths = brain.relations.findPath(args.fromId, args.toId, args.maxDepth ?? 5);

    if (paths.length === 0) {
      return {
        content: [{ type: 'text', text: `No path found between "${from.name}" and "${to.name}".` }],
      };
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

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
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
      return {
        content: [{ type: 'text', text: 'No decisions found.' }],
      };
    }

    const text = results
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

    return {
      content: [{ type: 'text', text: `Found ${results.length} decision(s):\n\n${text}` }],
    };
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
      return {
        content: [{ type: 'text', text: 'No patterns found.' }],
      };
    }

    const text = results
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

    return {
      content: [{ type: 'text', text: `Found ${results.length} pattern(s):\n\n${text}` }],
    };
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

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });
}
