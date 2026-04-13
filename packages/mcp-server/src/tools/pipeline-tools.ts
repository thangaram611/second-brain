import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Brain } from '@second-brain/core';
import {
  exportJson,
  exportJsonLd,
  exportDot,
  importGraph,
  type ExportFormat,
  type ImportOptions,
} from '@second-brain/core';
import {
  resolveLLMConfig,
  EmbeddingGenerator,
  EmbedPipeline,
  LLMExtractor,
} from '@second-brain/ingestion';
import { ENTITY_TYPES } from '@second-brain/types';
import type { EntityType } from '@second-brain/types';
import { VectorSearchChannel } from '@second-brain/core';

const EXPORT_FORMATS = ['json', 'json-ld', 'dot'] as const;
const IMPORT_FORMATS = ['json', 'json-ld'] as const;
const STRATEGIES = ['replace', 'merge', 'upsert'] as const;

export function registerPipelineTools(mcp: McpServer, brain: Brain): void {
  // --- reindex ---
  mcp.registerTool(
    'reindex',
    {
      description:
        'Rebuild the FTS5 full-text search index. Useful after bulk imports or if search results seem stale.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => {
      brain.storage.sqlite.exec("INSERT INTO entities_fts(entities_fts) VALUES('rebuild')");
      return {
        content: [{ type: 'text', text: 'FTS5 index rebuilt successfully.' }],
      };
    },
  );

  // --- export_graph ---
  mcp.registerTool(
    'export_graph',
    {
      description:
        'Export the knowledge graph in JSON, JSON-LD (Schema.org-aligned), or DOT (Graphviz) format. Returns the serialized content.',
      inputSchema: {
        format: z.enum(EXPORT_FORMATS).describe('Output format'),
        namespace: z.string().optional().describe('Filter to a single namespace'),
        types: z.array(z.enum(ENTITY_TYPES)).optional().describe('Filter to specific entity types'),
        includeRelations: z.boolean().optional().describe('Include relations (default: true)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const opts = {
        format: args.format as ExportFormat,
        namespace: args.namespace,
        types: args.types as EntityType[] | undefined,
        includeRelations: args.includeRelations,
      };
      const content = exportFor(brain, opts);
      return {
        content: [{ type: 'text', text: content }],
      };
    },
  );

  // --- import_graph ---
  mcp.registerTool(
    'import_graph',
    {
      description:
        'Import entities + relations from a JSON or JSON-LD payload. Strategy controls conflict handling: replace clears the namespace first, merge skips existing, upsert updates in place.',
      inputSchema: {
        content: z.string().describe('Serialized graph payload'),
        format: z.enum(IMPORT_FORMATS).describe('Source format'),
        strategy: z.enum(STRATEGIES).optional().describe('Merge strategy (default: upsert)'),
        namespace: z.string().optional().describe('Override namespace for all imported items'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const opts: ImportOptions = {
        format: args.format,
        strategy: args.strategy ?? 'upsert',
        namespace: args.namespace,
      };
      const result = importGraph(brain, args.content, opts);
      const conflictText =
        result.conflicts.length === 0
          ? ''
          : `\n${result.conflicts.length} conflict(s):\n${result.conflicts
              .slice(0, 10)
              .map((c) => `  - ${c.entityType}/${c.entityName}: ${c.reason}`)
              .join('\n')}`;
      return {
        content: [
          {
            type: 'text',
            text: `Imported ${result.entitiesImported} entities, ${result.relationsImported} relations.${conflictText}`,
          },
        ],
      };
    },
  );

  // --- rebuild_embeddings ---
  mcp.registerTool(
    'rebuild_embeddings',
    {
      description:
        'Generate (or regenerate) vector embeddings for entities. Requires LLM/embedding config in env (BRAIN_LLM_PROVIDER, BRAIN_EMBEDDING_MODEL, etc.). Skips entities whose content has not changed.',
      inputSchema: {
        namespace: z.string().optional().describe('Limit to a single namespace'),
        batchSize: z.number().int().min(1).max(500).optional().describe('Embeddings per request (default 64)'),
        dimensions: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Embedding vector dimensions for the configured model. Required the first time vector search is enabled (e.g. 768 for nomic-embed-text, 1536 for text-embedding-3-small).',
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const cfg = resolveLLMConfig();
      const generator = new EmbeddingGenerator(cfg);

      if (brain.embeddings === null) {
        if (typeof args.dimensions !== 'number') {
          return {
            content: [
              {
                type: 'text',
                text: 'Vector search is not enabled and no `dimensions` argument was supplied. Pass `dimensions` to bootstrap (e.g. 768 for nomic-embed-text).',
              },
            ],
            isError: true,
          };
        }
        brain.enableVectorSearch(args.dimensions);
      }

      const pipeline = new EmbedPipeline(brain, generator, {
        namespace: args.namespace,
        batchSize: args.batchSize,
      });
      const summary = await pipeline.run();
      // Wire the vector channel for subsequent searches in this process.
      if (!brain.search.hasVectorChannel() && brain.embeddings !== null) {
        const ch = new VectorSearchChannel(brain.embeddings, brain.entities, (q) =>
          generator.generateOne(q),
        );
        brain.search.setVectorChannel(ch);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Embedded ${summary.embedded} entities (${summary.skipped} unchanged, ${summary.errors} errors) in ${summary.durationMs}ms using ${cfg.embeddingModel}.`,
          },
        ],
      };
    },
  );

  // --- query_graph ---
  mcp.registerTool(
    'query_graph',
    {
      description:
        'Natural-language query over the knowledge graph. When LLM is configured, the question is interpreted then mapped to a multi-channel search (FTS + vector). Falls back to plain FTS otherwise.',
      inputSchema: {
        question: z.string().describe('Natural language question'),
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const limit = args.limit ?? 10;
      let queryText = args.question;
      let usedLlm = false;

      // If LLM is configured, ask it to derive search keywords + relevant entity types.
      try {
        const cfg = resolveLLMConfig();
        const extractor = new LLMExtractor(cfg, {
          systemPrompt:
            'Given a natural-language question about a knowledge graph, output 1-3 concise search keywords (no punctuation) and any entity types that would be most relevant. Use the schema; do NOT invent relations.',
          maxInputChars: 1000,
        });
        const probe = await extractor.extract(args.question, {
          namespace: args.namespace,
          source: { type: 'manual' },
        });
        if (probe.entities.length > 0) {
          // Use entity names as search terms.
          queryText = probe.entities.map((e) => e.name).join(' ');
          usedLlm = true;
        }
      } catch {
        // No LLM configured or extraction failed → plain FTS fallback.
      }

      const results = await brain.search.searchMulti({
        query: queryText,
        namespace: args.namespace,
        limit,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No matches for "${args.question}"${usedLlm ? ` (interpreted as: ${queryText})` : ''}.`,
            },
          ],
        };
      }

      const lines = [
        `Top ${results.length} matches for "${args.question}"${usedLlm ? ` (interpreted as: ${queryText})` : ''}:`,
        ...results.map((r) => {
          const e = r.entity;
          return `[${e.type}] ${e.name} — score ${r.score.toFixed(3)} via ${r.matchChannel}\n  id: ${e.id}`;
        }),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

function exportFor(brain: Brain, opts: {
  format: ExportFormat;
  namespace?: string;
  types?: EntityType[];
  includeRelations?: boolean;
}): string {
  switch (opts.format) {
    case 'json':
      return exportJson(brain, opts);
    case 'json-ld':
      return exportJsonLd(brain, opts);
    case 'dot':
      return exportDot(brain, opts);
  }
}
