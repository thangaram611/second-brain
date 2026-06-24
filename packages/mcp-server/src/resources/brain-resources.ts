import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brain } from '@second-brain/core';
import { ENTITY_TYPES, isEntityType } from '@second-brain/types';

/**
 * URI-template variables arrive as `string | string[]` (a var can repeat).
 * Our templates use single `{id}`/`{type}`/`{query}` placeholders, so collapse
 * to a single string, taking the first element if an array somehow appears.
 */
function templateVar(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

export function registerResources(mcp: McpServer, brain: Brain): void {
  // --- brain://entities/{id} ---
  mcp.registerResource(
    'entity',
    new ResourceTemplate('brain://entities/{id}', {
      list: () => {
        const allEntities = brain.entities.list({ limit: 100 });
        return {
          resources: allEntities.map((e) => ({
            uri: `brain://entities/${e.id}`,
            name: `[${e.type}] ${e.name}`,
            description: e.observations[0] ?? `${e.type} entity`,
            mimeType: 'application/json',
          })),
        };
      },
      complete: {
        id: (value) => {
          const matches = brain.entities.findByName(value);
          return matches.map((e) => e.id);
        },
      },
    }),
    {
      description: 'A specific entity in the knowledge graph',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const id = templateVar(params.id);
      const entity = brain.entities.get(id);
      if (!entity) {
        return { contents: [{ uri: uri.href, text: `Entity not found: ${id}`, mimeType: 'text/plain' }] };
      }

      brain.entities.touch(id);

      const outbound = brain.relations.getOutbound(id);
      const inbound = brain.relations.getInbound(id);

      const data = {
        ...entity,
        relations: {
          outbound: outbound.map((r) => ({
            type: r.type,
            targetId: r.targetId,
            weight: r.weight,
          })),
          inbound: inbound.map((r) => ({
            type: r.type,
            sourceId: r.sourceId,
            weight: r.weight,
          })),
        },
      };

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // --- brain://entities/type/{type} ---
  mcp.registerResource(
    'entities-by-type',
    new ResourceTemplate('brain://entities/type/{type}', {
      list: () => {
        return {
          resources: ENTITY_TYPES.map((t) => ({
            uri: `brain://entities/type/${t}`,
            name: `${t} entities`,
            description: `All entities of type "${t}"`,
            mimeType: 'application/json',
          })),
        };
      },
      complete: {
        type: (value) => {
          return ENTITY_TYPES.filter((t) => t.startsWith(value));
        },
      },
    }),
    {
      description: 'List entities filtered by type',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const type = templateVar(params.type);
      if (!isEntityType(type)) {
        return {
          contents: [
            { uri: uri.href, text: `Invalid entity type: ${type}`, mimeType: 'text/plain' },
          ],
        };
      }
      const results = brain.entities.findByType(type);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(results, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // --- brain://search/{query} ---
  mcp.registerResource(
    'search',
    new ResourceTemplate('brain://search/{query}', {
      list: undefined,
    }),
    {
      description: 'Search results for a query',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const query = decodeURIComponent(templateVar(params.query));
      const results = brain.search.search({ query, limit: 20 });
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              results.map((r) => ({
                entity: r.entity,
                score: r.score,
                matchChannel: r.matchChannel,
              })),
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // --- brain://graph/stats ---
  mcp.registerResource(
    'graph-stats',
    'brain://graph/stats',
    {
      description: 'Knowledge graph statistics: entity/relation counts, types, namespaces',
      mimeType: 'application/json',
    },
    async (uri) => {
      const stats = brain.search.getStats();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(stats, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );
}
