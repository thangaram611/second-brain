import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brain } from '@second-brain/core';
import { BRANCH_STATUSES, ENTITY_TYPES, RELATION_TYPES } from '@second-brain/types';
import type { EntityType, RelationType } from '@second-brain/types';

export function registerWriteTools(mcp: McpServer, brain: Brain): void {
  // --- add_entity ---
  mcp.registerTool('add_entity', {
    description: 'Create a new entity in the knowledge graph with type, name, observations, and tags.',
    inputSchema: {
      type: z.enum(ENTITY_TYPES).describe('Entity type'),
      name: z.string().describe('Human-readable entity name'),
      observations: z
        .array(z.string())
        .optional()
        .describe('Atomic facts about this entity'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      namespace: z.string().optional().describe('Namespace (default: "personal")'),
      properties: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Type-specific structured properties'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Confidence score (0.0-1.0, default 1.0)'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const entity = brain.entities.create({
      type: args.type as EntityType,
      name: args.name,
      observations: args.observations ?? [],
      tags: args.tags ?? [],
      namespace: args.namespace,
      properties: args.properties,
      confidence: args.confidence,
      source: { type: 'manual' },
    });

    return {
      content: [
        {
          type: 'text',
          text: `Created ${entity.type}: "${entity.name}" (${entity.id})`,
        },
      ],
    };
  });

  // --- add_relation ---
  mcp.registerTool('add_relation', {
    description: 'Create a relationship between two entities in the knowledge graph.',
    inputSchema: {
      type: z.enum(RELATION_TYPES).describe('Relation type'),
      sourceId: z.string().describe('Source entity ID'),
      targetId: z.string().describe('Target entity ID'),
      namespace: z.string().optional().describe('Namespace (default: "personal")'),
      weight: z.number().min(0).max(1).optional().describe('Relation weight (0.0-1.0, default 1.0)'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence score (0.0-1.0, default 1.0)'),
      bidirectional: z.boolean().optional().describe('Whether the relation is bidirectional'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Relation-specific properties'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    // Validate both entities exist
    const source = brain.entities.get(args.sourceId);
    if (!source) {
      return {
        content: [{ type: 'text', text: `Source entity not found: ${args.sourceId}` }],
        isError: true,
      };
    }
    const target = brain.entities.get(args.targetId);
    if (!target) {
      return {
        content: [{ type: 'text', text: `Target entity not found: ${args.targetId}` }],
        isError: true,
      };
    }

    const relation = brain.relations.create({
      type: args.type as RelationType,
      sourceId: args.sourceId,
      targetId: args.targetId,
      namespace: args.namespace,
      weight: args.weight,
      confidence: args.confidence,
      bidirectional: args.bidirectional,
      properties: args.properties,
      source: { type: 'manual' },
    });

    return {
      content: [
        {
          type: 'text',
          text: `Created relation: "${source.name}" --[${relation.type}]--> "${target.name}" (${relation.id})`,
        },
      ],
    };
  });

  // --- add_observation ---
  mcp.registerTool('add_observation', {
    description: 'Append an atomic fact (observation) to an existing entity.',
    inputSchema: {
      entityId: z.string().describe('Entity ID to add observation to'),
      observation: z.string().describe('The observation text (an atomic fact)'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const updated = brain.entities.addObservation(args.entityId, args.observation);
    if (!updated) {
      return {
        content: [{ type: 'text', text: `Entity not found: ${args.entityId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Added observation to "${updated.name}". Now has ${updated.observations.length} observation(s).`,
        },
      ],
    };
  });

  // --- record_decision ---
  mcp.registerTool('record_decision', {
    description:
      'Record a decision with context. Creates a decision entity and optionally links it to related entities.',
    inputSchema: {
      decision: z.string().describe('The decision made'),
      context: z.string().optional().describe('Context or reasoning behind the decision'),
      relatedEntityIds: z
        .array(z.string())
        .optional()
        .describe('IDs of related entities to link via decided_in relations'),
      namespace: z.string().optional().describe('Namespace (default: "personal")'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const observations = [args.decision];
    if (args.context) observations.push(`Context: ${args.context}`);

    const entity = brain.entities.create({
      type: 'decision',
      name: args.decision.slice(0, 100),
      namespace: args.namespace,
      observations,
      tags: args.tags ?? [],
      source: { type: 'manual' },
    });

    // Create relations to related entities
    const createdRelations: string[] = [];
    if (args.relatedEntityIds) {
      for (const relatedId of args.relatedEntityIds) {
        const related = brain.entities.get(relatedId);
        if (related) {
          brain.relations.create({
            type: 'decided_in',
            sourceId: entity.id,
            targetId: relatedId,
            namespace: args.namespace,
            source: { type: 'manual' },
          });
          createdRelations.push(related.name);
        }
      }
    }

    let text = `Decision recorded: "${entity.name}" (${entity.id})`;
    if (createdRelations.length > 0) {
      text += `\nLinked to: ${createdRelations.join(', ')}`;
    }

    return {
      content: [{ type: 'text', text }],
    };
  });

  // --- record_pattern ---
  mcp.registerTool('record_pattern', {
    description:
      'Record a recurring pattern with examples. Creates a pattern entity and optionally links to example entities.',
    inputSchema: {
      name: z.string().describe('Pattern name'),
      observations: z
        .array(z.string())
        .optional()
        .describe('Observations about this pattern'),
      exampleEntityIds: z
        .array(z.string())
        .optional()
        .describe('IDs of entities that exemplify this pattern'),
      namespace: z.string().optional().describe('Namespace (default: "personal")'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const entity = brain.entities.create({
      type: 'pattern',
      name: args.name,
      namespace: args.namespace,
      observations: args.observations ?? [],
      tags: args.tags ?? [],
      source: { type: 'manual' },
    });

    const linked: string[] = [];
    if (args.exampleEntityIds) {
      for (const exampleId of args.exampleEntityIds) {
        const example = brain.entities.get(exampleId);
        if (example) {
          brain.relations.create({
            type: 'implements',
            sourceId: exampleId,
            targetId: entity.id,
            namespace: args.namespace,
            source: { type: 'manual' },
          });
          linked.push(example.name);
        }
      }
    }

    let text = `Pattern recorded: "${entity.name}" (${entity.id})`;
    if (linked.length > 0) {
      text += `\nExamples linked: ${linked.join(', ')}`;
    }

    return {
      content: [{ type: 'text', text }],
    };
  });

  // --- record_fact ---
  mcp.registerTool('record_fact', {
    description: 'Record a discrete fact with source tracking.',
    inputSchema: {
      name: z.string().describe('Short fact title'),
      observations: z
        .array(z.string())
        .describe('The fact details as atomic observations'),
      sourceRef: z.string().optional().describe('Source reference (URL, commit hash, etc.)'),
      namespace: z.string().optional().describe('Namespace (default: "personal")'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence (default 1.0)'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const entity = brain.entities.create({
      type: 'fact',
      name: args.name,
      namespace: args.namespace,
      observations: args.observations,
      tags: args.tags ?? [],
      confidence: args.confidence,
      source: { type: 'manual', ref: args.sourceRef },
    });

    return {
      content: [
        {
          type: 'text',
          text: `Fact recorded: "${entity.name}" (${entity.id})`,
        },
      ],
    };
  });

  // --- update_entity ---
  mcp.registerTool('update_entity', {
    description: 'Update an existing entity\'s name, observations, tags, confidence, or properties.',
    inputSchema: {
      id: z.string().describe('Entity ID to update'),
      name: z.string().optional().describe('New name'),
      observations: z.array(z.string()).optional().describe('Replace all observations'),
      tags: z.array(z.string()).optional().describe('Replace all tags'),
      confidence: z.number().min(0).max(1).optional().describe('New confidence score'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Replace properties'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const { id, ...patch } = args;
    const updated = brain.entities.update(id, patch);

    if (!updated) {
      return {
        content: [{ type: 'text', text: `Entity not found: ${id}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Updated "${updated.name}" (${updated.id})`,
        },
      ],
    };
  });

  // --- merge_entities ---
  mcp.registerTool('merge_entities', {
    description:
      'Merge two duplicate entities. Keeps the primary entity, merges observations and tags from the secondary, re-points relations, and deletes the secondary.',
    inputSchema: {
      primaryId: z.string().describe('Entity to keep'),
      secondaryId: z.string().describe('Entity to merge into primary and delete'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const primary = brain.entities.get(args.primaryId);
    if (!primary) {
      return {
        content: [{ type: 'text', text: `Primary entity not found: ${args.primaryId}` }],
        isError: true,
      };
    }

    const secondary = brain.entities.get(args.secondaryId);
    if (!secondary) {
      return {
        content: [{ type: 'text', text: `Secondary entity not found: ${args.secondaryId}` }],
        isError: true,
      };
    }

    // Merge observations and tags
    const mergedObs = Array.from(new Set([...primary.observations, ...secondary.observations]));
    const mergedTags = Array.from(new Set([...primary.tags, ...secondary.tags]));
    const mergedProps = { ...secondary.properties, ...primary.properties };

    brain.entities.update(args.primaryId, {
      observations: mergedObs,
      tags: mergedTags,
      properties: mergedProps,
    });

    // Re-point relations from secondary to primary using batchUpsert
    // (handles duplicate edge constraint gracefully)
    const secondaryOutbound = brain.relations.getOutbound(args.secondaryId);
    const secondaryInbound = brain.relations.getInbound(args.secondaryId);

    const toUpsert: Array<import('@second-brain/types').CreateRelationInput> = [];
    for (const rel of secondaryOutbound) {
      if (rel.targetId !== args.primaryId) {
        toUpsert.push({
          type: rel.type,
          sourceId: args.primaryId,
          targetId: rel.targetId,
          namespace: rel.namespace,
          weight: rel.weight,
          confidence: rel.confidence,
          source: rel.source,
        });
      }
    }
    for (const rel of secondaryInbound) {
      if (rel.sourceId !== args.primaryId) {
        toUpsert.push({
          type: rel.type,
          sourceId: rel.sourceId,
          targetId: args.primaryId,
          namespace: rel.namespace,
          weight: rel.weight,
          confidence: rel.confidence,
          source: rel.source,
        });
      }
    }
    const repointed = brain.relations.batchUpsert(toUpsert).length;

    // Delete secondary (cascades its relations)
    brain.entities.delete(args.secondaryId);

    return {
      content: [
        {
          type: 'text',
          text: `Merged "${secondary.name}" into "${primary.name}". ${mergedObs.length} observations, ${mergedTags.length} tags, ${repointed} relations re-pointed.`,
        },
      ],
    };
  });

  // --- invalidate ---
  mcp.registerTool('invalidate', {
    description:
      'Mark an entity as superseded by another entity. Sets confidence to 0 and creates a "supersedes" relation from the replacement to the invalidated entity.',
    inputSchema: {
      entityId: z.string().describe('Entity to invalidate'),
      replacementId: z
        .string()
        .optional()
        .describe('Entity that supersedes this one (creates supersedes relation)'),
      reason: z.string().optional().describe('Reason for invalidation'),
    },
    annotations: {
      readOnlyHint: false,
    },
  }, async (args) => {
    const entity = brain.entities.get(args.entityId);
    if (!entity) {
      return {
        content: [{ type: 'text', text: `Entity not found: ${args.entityId}` }],
        isError: true,
      };
    }

    // Set confidence to 0 (soft delete)
    const observations = [...entity.observations];
    if (args.reason) {
      observations.push(`Invalidated: ${args.reason}`);
    }
    brain.entities.update(args.entityId, { confidence: 0, observations });

    // Create supersedes relation if replacement provided
    if (args.replacementId) {
      const replacement = brain.entities.get(args.replacementId);
      if (!replacement) {
        return {
          content: [{ type: 'text', text: `Replacement entity not found: ${args.replacementId}` }],
          isError: true,
        };
      }
      brain.relations.create({
        type: 'supersedes',
        sourceId: args.replacementId,
        targetId: args.entityId,
        namespace: entity.namespace,
        source: { type: 'manual' },
      });

      return {
        content: [
          {
            type: 'text',
            text: `Invalidated "${entity.name}". Superseded by "${replacement.name}".`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Invalidated "${entity.name}" (confidence set to 0).`,
        },
      ],
    };
  });

  // --- resolve_contradiction ---
  mcp.registerTool('resolve_contradiction', {
    description:
      'Resolve a contradiction by picking a winner. Creates a "supersedes" relation from winner to loser, sets loser confidence to 0, and deletes the contradicts relation.',
    inputSchema: {
      relationId: z.string().describe('ID of the contradicts relation'),
      winnerId: z.string().describe('ID of the entity that should win (survive)'),
    },
  }, async (args) => {
    try {
      const rel = brain.relations.get(args.relationId);
      if (!rel) {
        return {
          content: [{ type: 'text', text: `Relation not found: ${args.relationId}` }],
          isError: true,
        };
      }

      const loserId = rel.sourceId === args.winnerId ? rel.targetId : rel.sourceId;
      const winner = brain.entities.get(args.winnerId);
      const loser = brain.entities.get(loserId);

      brain.contradictions.resolve(args.relationId, args.winnerId);

      return {
        content: [
          {
            type: 'text',
            text: `Contradiction resolved: "${winner?.name ?? args.winnerId}" supersedes "${loser?.name ?? loserId}".`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // --- dismiss_contradiction ---
  mcp.registerTool('dismiss_contradiction', {
    description:
      'Dismiss a contradiction without resolving it. Deletes the contradicts relation but leaves both entities unchanged.',
    inputSchema: {
      relationId: z.string().describe('ID of the contradicts relation to dismiss'),
    },
  }, async (args) => {
    try {
      brain.contradictions.dismiss(args.relationId);

      return {
        content: [
          {
            type: 'text',
            text: `Contradiction dismissed (relation ${args.relationId} deleted).`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // --- flip_branch_status ---
  mcp.registerTool('flip_branch_status', {
    description:
      'Bulk-update branchContext.status on every entity and relation carrying a given branch. Admin escape hatch for when provider webhooks are unavailable or a local merge needs to be re-stamped.',
    inputSchema: {
      branch: z.string().min(1).describe('Branch name to flip (exact match on branchContext.branch)'),
      status: z.enum(BRANCH_STATUSES).describe('New status: wip | merged | abandoned'),
      mrIid: z.number().int().nullable().optional().describe('Optional MR/PR iid'),
      mergedAt: z
        .string()
        .datetime()
        .nullable()
        .optional()
        .describe('ISO timestamp when status=merged'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
  }, async (args) => {
    try {
      const result = brain.flipBranchStatus(args.branch, {
        status: args.status,
        mrIid: args.mrIid ?? null,
        mergedAt: args.mergedAt ?? null,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Flipped branch "${args.branch}" → ${args.status}. Updated entities=${result.updatedEntities}, relations=${result.updatedRelations}.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });
}
