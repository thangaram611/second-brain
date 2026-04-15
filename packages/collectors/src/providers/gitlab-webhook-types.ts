import { z } from 'zod';

/**
 * Zod schemas for the subset of GitLab webhook payloads we consume.
 * All schemas are `.passthrough()` so future field additions don't
 * fail validation. No `as` casts — callers consume `z.infer<>`.
 *
 * Reference:
 *   https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html
 */

// ─── Shared sub-schemas ────────────────────────────────────────────────────

export const GitLabWebhookUserSchema = z
  .object({
    id: z.number().int().optional(),
    username: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

export const GitLabWebhookProjectSchema = z
  .object({
    id: z.number().int(),
    path_with_namespace: z.string(),
    web_url: z.string().optional(),
  })
  .passthrough();

// The `labels: [{ title, color, ... }]` shape used by MR webhook events
// (differs slightly from the REST API which can return bare strings).
const WebhookLabelSchema = z
  .object({
    id: z.number().int().optional(),
    title: z.string(),
  })
  .passthrough();

// ─── merge_request events ─────────────────────────────────────────────────

export const MR_ACTIONS = ['open', 'reopen', 'update', 'approved', 'unapproved', 'merge', 'close'] as const;
export type MrAction = (typeof MR_ACTIONS)[number];

export const GitLabMRObjectAttrsSchema = z
  .object({
    id: z.number().int(),
    iid: z.number().int(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    action: z.enum(MR_ACTIONS).optional(),
    source_branch: z.string(),
    target_branch: z.string(),
    url: z.string().optional(),
    web_url: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    merge_status: z.string().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
  })
  .passthrough();

export const GitLabMREventSchema = z
  .object({
    object_kind: z.literal('merge_request'),
    event_type: z.literal('merge_request').optional(),
    user: GitLabWebhookUserSchema,
    project: GitLabWebhookProjectSchema,
    object_attributes: GitLabMRObjectAttrsSchema,
    labels: z.array(WebhookLabelSchema).optional(),
    changes: z.record(z.string(), z.unknown()).optional(),
    assignees: z.array(GitLabWebhookUserSchema).optional(),
    reviewers: z.array(GitLabWebhookUserSchema).optional(),
  })
  .passthrough();

export type GitLabMREvent = z.infer<typeof GitLabMREventSchema>;

// ─── note events (MR comments) ────────────────────────────────────────────

export const GitLabNoteObjectAttrsSchema = z
  .object({
    id: z.number().int(),
    note: z.string(),
    noteable_type: z.string(),
    noteable_id: z.number().int().nullable().optional(),
    url: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

/** The nested `merge_request` object inside a note event — a condensed
    shape. We validate only the fields we read back. */
export const GitLabNoteMergeRequestSchema = z
  .object({
    iid: z.number().int(),
    title: z.string().optional(),
    url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();

export const GitLabMRNoteEventSchema = z
  .object({
    object_kind: z.literal('note'),
    user: GitLabWebhookUserSchema,
    project: GitLabWebhookProjectSchema,
    object_attributes: GitLabNoteObjectAttrsSchema.extend({
      noteable_type: z.literal('MergeRequest'),
    }),
    merge_request: GitLabNoteMergeRequestSchema,
  })
  .passthrough();

export type GitLabMRNoteEvent = z.infer<typeof GitLabMRNoteEventSchema>;

// ─── pipeline events ──────────────────────────────────────────────────────

export const GitLabPipelineObjectAttrsSchema = z
  .object({
    id: z.number().int(),
    status: z.string(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  })
  .passthrough();

export const GitLabPipelineMRSchema = z
  .object({
    iid: z.number().int(),
    url: z.string().optional(),
    title: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
  })
  .passthrough();

/**
 * `merge_request` top-level field is only populated when the pipeline was
 * triggered by an MR (i.e. merge-train or merged_result detached pipeline).
 * For push-on-branch pipelines it is omitted. We require it to mean "this
 * pipeline has an MR we can update" and skip otherwise.
 */
export const GitLabPipelineEventSchema = z
  .object({
    object_kind: z.literal('pipeline'),
    user: GitLabWebhookUserSchema.optional(),
    project: GitLabWebhookProjectSchema,
    object_attributes: GitLabPipelineObjectAttrsSchema,
    merge_request: GitLabPipelineMRSchema.optional(),
  })
  .passthrough();

export type GitLabPipelineEvent = z.infer<typeof GitLabPipelineEventSchema>;

// ─── Dispatch schema ──────────────────────────────────────────────────────

/**
 * A top-level discriminator. Use
 * `GitLabWebhookEventSchema.safeParse(raw)` first; on success, pick the
 * per-kind schema for full validation. Avoids blowing up on new event
 * kinds we don't care about yet (we just return [] from mapEvent).
 */
export const GitLabWebhookEventSchema = z
  .object({
    object_kind: z.string(),
  })
  .passthrough();

export type GitLabWebhookEnvelope = z.infer<typeof GitLabWebhookEventSchema>;

// ─── REST-side schemas consumed by backfill + user-email cache ───────────

export const GitLabUserRestSchema = z
  .object({
    id: z.number().int(),
    username: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
    public_email: z.string().optional(),
    commit_email: z.string().optional(),
  })
  .passthrough();

export type GitLabUserRest = z.infer<typeof GitLabUserRestSchema>;

export const GitLabProjectRestSchema = z
  .object({
    id: z.number().int(),
    path_with_namespace: z.string(),
    default_branch: z.string().nullable().optional(),
    web_url: z.string().optional(),
  })
  .passthrough();

export type GitLabProjectRest = z.infer<typeof GitLabProjectRestSchema>;

export const GitLabHookRestSchema = z
  .object({
    id: z.number().int(),
    url: z.string(),
    merge_requests_events: z.boolean().optional(),
    note_events: z.boolean().optional(),
    pipeline_events: z.boolean().optional(),
    push_events: z.boolean().optional(),
  })
  .passthrough();

export type GitLabHookRest = z.infer<typeof GitLabHookRestSchema>;

export const GitLabMRChangeFileSchema = z
  .object({
    new_path: z.string(),
    old_path: z.string().optional(),
    new_file: z.boolean().optional(),
    deleted_file: z.boolean().optional(),
    renamed_file: z.boolean().optional(),
  })
  .passthrough();

export const GitLabMRChangesResponseSchema = z
  .object({
    changes: z.array(GitLabMRChangeFileSchema).optional(),
  })
  .passthrough();

export type GitLabMRChangesResponse = z.infer<typeof GitLabMRChangesResponseSchema>;
