import { Router } from 'express';
import {
  exportJson,
  exportJsonLd,
  exportDot,
  importGraph,
  VectorSearchChannel,
  type Brain,
  type ExportFormat,
} from '@second-brain/core';
import {
  resolveLLMConfig,
  EmbeddingGenerator,
  EmbedPipeline,
  LLMExtractor,
} from '@second-brain/ingestion';
import {
  ExportGraphSchema,
  ImportGraphSchema,
  RebuildEmbeddingsSchema,
  QueryGraphSchema,
} from '../schemas.js';

/**
 * Admin / pipeline routes added in Phase 7:
 *   POST /api/reindex            — rebuild FTS index
 *   POST /api/export             — serialize the graph (JSON / JSON-LD / DOT)
 *   POST /api/import             — load entities + relations from a payload
 *   POST /api/rebuild-embeddings — re-embed entities (requires LLM config)
 *   POST /api/query              — natural-language query
 */
export function adminRoutes(brain: Brain): Router {
  const router = Router();

  router.post('/api/reindex', (_req, res) => {
    brain.storage.sqlite.exec("INSERT INTO entities_fts(entities_fts) VALUES('rebuild')");
    res.json({ ok: true });
  });

  router.post('/api/export', (req, res) => {
    const opts = ExportGraphSchema.parse(req.body);
    const content = exportFor(brain, opts);
    res.json({ format: opts.format, content });
  });

  router.post('/api/import', (req, res) => {
    const opts = ImportGraphSchema.parse(req.body);
    const result = importGraph(brain, opts.content, {
      format: opts.format,
      strategy: opts.strategy ?? 'upsert',
      namespace: opts.namespace,
    });
    res.json(result);
  });

  router.post('/api/rebuild-embeddings', async (req, res) => {
    const opts = RebuildEmbeddingsSchema.parse(req.body ?? {});
    let cfg;
    try {
      cfg = resolveLLMConfig();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Invalid LLM config: ${msg}` });
      return;
    }
    if (brain.embeddings === null) {
      if (typeof opts.dimensions !== 'number') {
        res.status(400).json({
          error:
            'Vector search not enabled. Pass `dimensions` (e.g. 768) to bootstrap.',
        });
        return;
      }
      brain.enableVectorSearch(opts.dimensions);
    }
    const generator = new EmbeddingGenerator(cfg);
    const pipeline = new EmbedPipeline(brain, generator, {
      namespace: opts.namespace,
      batchSize: opts.batchSize,
    });
    try {
      const summary = await pipeline.run();
      if (!brain.search.hasVectorChannel() && brain.embeddings !== null) {
        brain.search.setVectorChannel(
          new VectorSearchChannel(brain.embeddings, brain.entities, (q) =>
            generator.generateOne(q),
          ),
        );
      }
      res.json({ ok: true, model: cfg.embeddingModel, ...summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/query', async (req, res) => {
    const opts = QueryGraphSchema.parse(req.body);
    let queryText = opts.question;
    let usedLlm = false;
    try {
      const cfg = resolveLLMConfig();
      const extractor = new LLMExtractor(cfg, {
        systemPrompt:
          'Extract 1-3 short search keywords from the user question. Output as entity names; the type field is irrelevant. Do NOT invent relations.',
        maxInputChars: 1000,
      });
      const probe = await extractor.extract(opts.question, {
        namespace: opts.namespace,
        source: { type: 'manual' },
      });
      if (probe.entities.length > 0) {
        queryText = probe.entities.map((e) => e.name).join(' ');
        usedLlm = true;
      }
    } catch {
      // No LLM → fall back to plain FTS.
    }

    const results = await brain.search.searchMulti({
      query: queryText,
      namespace: opts.namespace,
      limit: opts.limit ?? 10,
    });

    res.json({
      question: opts.question,
      interpreted: usedLlm ? queryText : null,
      results,
    });
  });

  return router;
}

function exportFor(brain: Brain, opts: {
  format: ExportFormat;
  namespace?: string;
  types?: import('@second-brain/types').EntityType[];
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
