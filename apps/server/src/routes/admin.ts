import { Router } from 'express';
import { z } from 'zod';
import {
  exportJson,
  exportJsonLd,
  exportDot,
  importGraph,
  VectorSearchChannel,
  type Brain,
  type ExportFormat,
} from '@second-brain/core';
import { createLogger } from '@second-brain/core';
import {
  resolveLLMConfig,
  EmbedPipeline,
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
} from '@second-brain/collectors';
import { newJti, signInvite, type InvitePayload } from '../lib/invite.js';
import type { UsersService } from '../services/users.js';
import { requireAdmin, type RequestWithUser } from '../middleware/auth.js';

const serverLogger = createLogger('server.admin');
import {
  ExportGraphSchema,
  ImportGraphSchema,
  RebuildEmbeddingsSchema,
  QueryGraphSchema,
} from '../schemas.js';

export interface AdminAuthOptions {
  users?: UsersService;
  inviteSigningKey?: string | null;
  /** Override clock for tests. */
  now?: () => number;
}

const ScopeSchema = z.enum(['hook:read', 'read', 'write', 'admin']);
const CreateInviteSchema = z.object({
  namespace: z.string().min(1),
  role: z.enum(['member', 'admin']).default('member'),
  scopes: z.array(ScopeSchema).default(['read', 'write']),
  ttlMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
});

/**
 * Admin / pipeline routes added in Phase 7:
 *   POST /api/reindex            — rebuild FTS index
 *   POST /api/export             — serialize the graph (JSON / JSON-LD / DOT)
 *   POST /api/import             — load entities + relations from a payload
 *   POST /api/rebuild-embeddings — re-embed entities (requires LLM config)
 *   POST /api/query              — natural-language query
 *
 * Phase auth/PR1 additions (only mounted when `authOptions.users` is set):
 *   POST   /api/admin/invites    — mint a single-use HMAC invite (admin only)
 *   DELETE /api/admin/tokens/:id — revoke a token (admin only)
 */
export function adminRoutes(brain: Brain, authOptions: AdminAuthOptions = {}): Router {
  const router = Router();
  const now = authOptions.now ?? Date.now;

  router.post('/api/reindex', requireAdmin, (_req, res) => {
    brain.storage.sqlite.exec("INSERT INTO entities_fts(entities_fts) VALUES('rebuild')");
    res.json({ ok: true });
  });

  router.get('/api/embeddings/status', requireAdmin, (_req, res) => {
    const rows = brain.storage.sqlite
      .prepare(
        `SELECT
           e.namespace AS namespace,
           COUNT(*) AS total,
           SUM(CASE WHEN emb.entity_id IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM entities e
         LEFT JOIN embeddings emb ON emb.entity_id = e.id
         GROUP BY e.namespace
         ORDER BY e.namespace`,
      )
      .all() as Array<{ namespace: string; total: number; embedded: number }>;
    res.json({
      vectorEnabled: brain.embeddings !== null,
      byNamespace: rows.map((r) => ({
        namespace: r.namespace,
        total: r.total,
        embedded: r.embedded,
        coverage: r.total > 0 ? r.embedded / r.total : 0,
      })),
    });
  });

  router.post('/api/export', requireAdmin, (req, res) => {
    const opts = ExportGraphSchema.parse(req.body);
    const content = exportFor(brain, opts);
    res.json({ format: opts.format, content });
  });

  router.post('/api/import', requireAdmin, (req, res) => {
    const opts = ImportGraphSchema.parse(req.body);
    const result = importGraph(brain, opts.content, {
      format: opts.format,
      strategy: opts.strategy ?? 'upsert',
      namespace: opts.namespace,
    });
    res.json(result);
  });

  router.post('/api/rebuild-embeddings', requireAdmin, async (req, res) => {
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
    const generator = tryCreateEmbeddingGenerator(cfg, { logger: serverLogger });
    if (!generator) {
      res.status(400).json({
        error:
          'Embedding provider requires an API key. Set BRAIN_EMBEDDING_API_KEY or BRAIN_LLM_API_KEY and retry.',
      });
      return;
    }
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

  router.post('/api/query', requireAdmin, async (req, res) => {
    const opts = QueryGraphSchema.parse(req.body);
    let queryText = opts.question;
    let usedLlm = false;
    try {
      const cfg = resolveLLMConfig();
      const extractor = tryCreateLLMExtractor(cfg, {
        logger: serverLogger,
        systemPrompt:
          'Extract 1-3 short search keywords from the user question. Output as entity names; the type field is irrelevant. Do NOT invent relations.',
        maxInputChars: 1000,
      });
      if (extractor) {
        const probe = await extractor.extract(opts.question, {
          namespace: opts.namespace,
          source: { type: 'manual' },
        });
        if (probe.entities.length > 0) {
          queryText = probe.entities.map((e) => e.name).join(' ');
          usedLlm = true;
        }
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

  // --- Auth admin: invites + token revocation -----------------------------

  if (authOptions.users) {
    const users = authOptions.users;

    router.post('/api/admin/invites', requireAdmin, (req: RequestWithUser, res, next) => {
      try {
        if (!authOptions.inviteSigningKey) {
          res.status(503).json({ error: 'invites-not-configured' });
          return;
        }
        const body = CreateInviteSchema.parse(req.body ?? {});
        const jti = newJti();
        const expiresAt = Math.floor((now() + body.ttlMs) / 1000); // seconds
        const payload: InvitePayload = {
          jti,
          namespace: body.namespace,
          role: body.role,
          scopes: body.scopes,
          exp: expiresAt,
        };
        const token = signInvite(payload, authOptions.inviteSigningKey);
        users.insertInvite({
          jti,
          namespace: body.namespace,
          role: body.role,
          scopes: [...body.scopes],
          expiresAt,
          consumedAt: null,
          signature: token,
          createdAt: now(),
        });
        res.status(201).json({ invite: token, jti, expiresAt: expiresAt * 1000 });
      } catch (err) {
        next(err);
      }
    });

    router.get('/api/admin/tokens', requireAdmin, (req, res, next) => {
      try {
        const emailRaw = req.query.email;
        if (typeof emailRaw !== 'string' || emailRaw.length === 0) {
          res.status(400).json({ error: 'email-required' });
          return;
        }
        const user = users.findUserByEmail(emailRaw);
        if (!user) {
          res.status(404).json({ error: 'user-not-found' });
          return;
        }
        // `users.listTokens` returns `TokenRecord` which by construction omits
        // the argon2 hash — see services/users.ts. Map to wire shape with
        // explicit fields so future TokenRecord additions don't accidentally
        // leak through.
        const records = users.listTokens(user.id).map((r) => ({
          id: r.id,
          userId: r.userId,
          label: r.label,
          scopes: r.scopes,
          namespace: r.namespace,
          createdAt: r.createdAt,
          lastUsedAt: r.lastUsedAt,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
        }));
        res.json({ tokens: records });
      } catch (err) {
        next(err);
      }
    });

    router.delete('/api/admin/tokens/:id', requireAdmin, (req, res, next) => {
      try {
        const tokenId = req.params.id;
        if (typeof tokenId !== 'string' || tokenId.length === 0) {
          res.status(400).json({ error: 'missing-token-id' });
          return;
        }
        const ok = users.revokeToken(tokenId);
        if (!ok) {
          res.status(404).json({ error: 'token-not-found-or-already-revoked' });
          return;
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    });
  }

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
