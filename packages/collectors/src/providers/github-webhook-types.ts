import { z } from 'zod';

/**
 * Zod schemas for the subset of GitHub webhook payloads we consume.
 * All schemas are `.passthrough()` so future field additions don't
 * fail validation. No `as` casts — callers consume `z.infer<>`.
 *
 * Reference:
 *   https://docs.github.com/en/webhooks/webhook-events-and-payloads
 */

// ─── Shared sub-schemas ────────────────────────────────────────────────────

export const GitHubWebhookUserSchema = z
  .object({
    login: z.string(),
    id: z.number().int().optional(),
    email: z.string().optional(),
  })
  .passthrough();

export type GitHubWebhookUser = z.infer<typeof GitHubWebhookUserSchema>;

// ─── pull_request events ──────────────────────────────────────────────────

export const GH_PR_ACTIONS = [
  'opened',
  'synchronize',
  'closed',
  'reopened',
  'ready_for_review',
  'edited',
] as const;
export type GhPrAction = (typeof GH_PR_ACTIONS)[number];

export const GitHubPRWebhookSchema = z
  .object({
    action: z.enum(GH_PR_ACTIONS),
    number: z.number().int(),
    pull_request: z
      .object({
        title: z.string(),
        body: z.string().nullable().optional(),
        state: z.string(),
        merged: z.boolean().nullable().optional(),
        merged_at: z.string().nullable().optional(),
        merge_commit_sha: z.string().nullable().optional(),
        head: z.object({ ref: z.string() }).passthrough(),
        base: z.object({ ref: z.string() }).passthrough(),
        html_url: z.string().optional(),
        user: GitHubWebhookUserSchema,
        draft: z.boolean().optional(),
        changed_files: z.number().int().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubPRWebhook = z.infer<typeof GitHubPRWebhookSchema>;

// ─── pull_request_review events ───────────────────────────────────────────

export const GitHubPRReviewWebhookSchema = z
  .object({
    action: z.enum(['submitted', 'edited', 'dismissed']),
    review: z
      .object({
        state: z.string(),
        body: z.string().nullable().optional(),
        user: GitHubWebhookUserSchema,
        submitted_at: z.string().optional(),
        html_url: z.string().optional(),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int(),
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubPRReviewWebhook = z.infer<typeof GitHubPRReviewWebhookSchema>;

// ─── pull_request_review_comment events ───────────────────────────────────

export const GitHubPRReviewCommentWebhookSchema = z
  .object({
    action: z.string(),
    comment: z
      .object({
        id: z.number().int(),
        body: z.string(),
        user: GitHubWebhookUserSchema,
        created_at: z.string(),
        path: z.string().optional(),
        line: z.number().int().nullable().optional(),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int(),
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubPRReviewCommentWebhook = z.infer<typeof GitHubPRReviewCommentWebhookSchema>;

// ─── check_suite events ──────────────────────────────────────────────────

export const GitHubCheckSuiteWebhookSchema = z
  .object({
    action: z.literal('completed'),
    check_suite: z
      .object({
        id: z.number().int(),
        conclusion: z.string().nullable(),
        head_branch: z.string().nullable().optional(),
        pull_requests: z
          .array(
            z.object({ number: z.number().int() }).passthrough(),
          )
          .default([]),
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubCheckSuiteWebhook = z.infer<typeof GitHubCheckSuiteWebhookSchema>;

// ─── REST-side schemas consumed by auth + hook management ─────────────────

export const GitHubUserRestSchema = z
  .object({
    id: z.number().int(),
    login: z.string(),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

export type GitHubUserRest = z.infer<typeof GitHubUserRestSchema>;

export const GitHubHookRestSchema = z
  .object({
    id: z.number().int(),
    config: z
      .object({
        url: z.string().optional(),
      })
      .passthrough(),
    events: z.array(z.string()).optional(),
  })
  .passthrough();

export type GitHubHookRest = z.infer<typeof GitHubHookRestSchema>;
