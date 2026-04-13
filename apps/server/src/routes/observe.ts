import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ObservationService } from '../services/observation-service.js';
import { tokenBucket } from '../services/rate-limit.js';

const SessionStartSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().optional(),
  tool: z.string().optional(),
  hookVersion: z.string().optional(),
  timestamp: z.string().optional(),
  project: z.string().optional(),
});

const PromptSubmitSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string(),
  timestamp: z.string().optional(),
});

const ToolUseSchema = z.object({
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  phase: z.enum(['pre', 'post', 'unknown']),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  durationMs: z.number().optional(),
  timestamp: z.string().optional(),
  filePaths: z.array(z.string()).optional(),
});

const SessionEndSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().optional(),
  timestamp: z.string().optional(),
});

const StopSchema = z.object({
  sessionId: z.string().min(1),
  timestamp: z.string().optional(),
});

function extractSessionKey(req: Request): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = body.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export interface ObserveRouteOptions {
  /** Burst capacity for per-session rate limit. Default 20. */
  burst?: number;
  /** Sustained refill (tokens per second) per session. Default 60. */
  sustained?: number;
  /** Require this bearer token when set. */
  bearerToken?: string;
}

export function observeRoutes(
  observations: ObservationService,
  options: ObserveRouteOptions = {},
): Router {
  const router = Router();

  // Bearer auth (mirrors MCP server pattern).
  if (options.bearerToken) {
    const expected = `Bearer ${options.bearerToken}`;
    router.use('/api/observe', (req, res, next) => {
      if (req.headers.authorization !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
  }

  const limiter = tokenBucket({
    burst: options.burst ?? 20,
    sustained: options.sustained ?? 60,
    keyFn: extractSessionKey,
    onDropped: () => observations.noteRateLimitDrop(),
  });

  router.use('/api/observe', limiter);

  router.post('/api/observe/session-start', async (req, res, next) => {
    try {
      const payload = SessionStartSchema.parse(req.body);
      const result = await observations.handleSessionStart(payload);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/observe/prompt-submit', (req, res) => {
    const payload = PromptSubmitSchema.parse(req.body);
    const result = observations.handlePromptSubmit(payload);
    res.json(result);
  });

  router.post('/api/observe/tool-use', (req, res) => {
    const payload = ToolUseSchema.parse(req.body);
    const result = observations.handleToolUse(payload);
    res.status(201).json(result);
  });

  router.post('/api/observe/stop', (req, res) => {
    const payload = StopSchema.parse(req.body);
    const result = observations.handleStop(payload);
    res.json(result);
  });

  router.post('/api/observe/session-end', async (req, res, next) => {
    try {
      const payload = SessionEndSchema.parse(req.body);
      const result = await observations.handleSessionEnd(payload);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/observe/counters', (_req, res) => {
    res.json(observations.counters);
  });

  return router;
}
