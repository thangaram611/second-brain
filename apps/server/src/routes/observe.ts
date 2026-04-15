import { Router, type Request } from 'express';
import { z } from 'zod';
import { AuthorSchema } from '@second-brain/types';
import { GitLabProvider, type MappedObservation, type WebhookSecret } from '@second-brain/collectors';
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

const FileChangeSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  namespace: z.string().min(1),
  author: AuthorSchema.optional(),
  changes: z.array(
    z.object({
      path: z.string().min(1),
      kind: z.enum(['add', 'change', 'unlink']),
      size: z.number().int().optional(),
      mtime: z.string(),
    }),
  ).min(1),
  batchedAt: z.string(),
  idempotencyKey: z.string().min(1),
});

const BranchChangeSchema = z.object({
  repo: z.string().min(1),
  namespace: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  headSha: z.string().min(1),
  author: AuthorSchema.optional(),
  timestamp: z.string().optional(),
});

/**
 * Phase 10.3 — MR event envelope. `namespace` is intentionally absent;
 * the server derives it from (provider, projectId) via
 * `observations.resolveWiredNamespace` so a malicious payload cannot
 * spoof a wiring.
 */
const MREventSchema = z.object({
  provider: z.enum(['gitlab']),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  /** Raw webhook envelope — parsed by the provider. */
  rawEvent: z.unknown(),
  /** Inbound HTTP headers forwarded by the relay client. */
  rawHeaders: z.record(z.string(), z.string()),
  timestamp: z.string().optional(),
});

const GitEventSchema = z.object({
  repo: z.string().min(1),
  namespace: z.string().min(1),
  kind: z.enum(['commit', 'merge', 'checkout']),
  branch: z.string().min(1),
  headSha: z.string().min(1),
  message: z.string().optional(),
  /** For kind='merge': the branch that was merged IN (not HEAD). Empty when */
  /** the hook can't determine it (e.g. rebase-as-merge). Server uses this to */
  /** call flipBranchStatus(mergedBranch, {status:'merged'}). */
  mergedBranch: z.string().optional(),
  author: AuthorSchema.optional(),
  timestamp: z.string().optional(),
});

function extractSessionKey(req: Request): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = body.sessionId;
  if (typeof id === 'string' && id.length > 0) return id;
  // For non-session routes (file-change, branch-change, git-event) fall back
  // to repo + namespace so the rate limiter still buckets per-source.
  const repo = body.repo;
  const namespace = body.namespace;
  if (typeof repo === 'string' && typeof namespace === 'string') {
    return `repo:${repo}:${namespace}`;
  }
  return null;
}

export interface ObserveRouteOptions {
  /** Burst capacity for per-session rate limit. Default 20. */
  burst?: number;
  /** Sustained refill (tokens per second) per session. Default 60. */
  sustained?: number;
  /** Require this bearer token when set. */
  bearerToken?: string;
  /**
   * Phase 10.3 — provider webhook secrets keyed by
   * `${provider}:${projectId}`. Server compares inbound `X-Gitlab-Token`
   * (or equivalent) against the configured secret using
   * `timingSafeEqual`. If a project has no entry here, mr-event deliveries
   * for it return 401.
   */
  webhookSecrets?: Map<string, WebhookSecret>;
  /**
   * Injected for tests — override the GitLab provider instance used by
   * the mr-event route. Defaults to `new GitLabProvider()`.
   */
  gitlabProvider?: import('@second-brain/collectors').GitProvider;
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

  router.post('/api/observe/file-change', (req, res, next) => {
    try {
      const payload = FileChangeSchema.parse(req.body);
      const result = observations.handleFileChange(payload);
      res.status(result.accepted ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/observe/branch-change', (req, res, next) => {
    try {
      const payload = BranchChangeSchema.parse(req.body);
      const result = observations.handleBranchChange(payload);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/observe/git-event', (req, res, next) => {
    try {
      const payload = GitEventSchema.parse(req.body);
      const result = observations.handleGitEvent(payload);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  const gitlabProvider = options.gitlabProvider ?? new GitLabProvider();
  const webhookSecrets = options.webhookSecrets ?? new Map<string, WebhookSecret>();

  router.post('/api/observe/mr-event', async (req, res, next) => {
    try {
      const payload = MREventSchema.parse(req.body);
      const secretKey = `${payload.provider}:${payload.projectId}`;
      const expected = webhookSecrets.get(secretKey);
      if (!expected) {
        res.status(401).json({ error: 'no-webhook-secret', projectId: payload.projectId });
        return;
      }
      const verification = gitlabProvider.verifyDelivery({
        request: { headers: payload.rawHeaders, rawBody: Buffer.from('') },
        expectedSecret: expected,
      });
      if (!verification.ok) {
        res.status(401).json({ error: 'verify-failed', reason: verification.reason });
        return;
      }

      const mapped: MappedObservation[] = await gitlabProvider.mapEvent({
        provider: payload.provider,
        rawBody: payload.rawEvent,
        rawHeaders: payload.rawHeaders,
        receivedAt: payload.timestamp ?? new Date().toISOString(),
        deliveryId: payload.deliveryId,
      });

      const result = observations.handleMREvent({
        provider: payload.provider,
        projectId: payload.projectId,
        deliveryId: payload.deliveryId,
        mapped,
        timestamp: payload.timestamp,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/observe/counters', (_req, res) => {
    res.json(observations.counters);
  });

  return router;
}
