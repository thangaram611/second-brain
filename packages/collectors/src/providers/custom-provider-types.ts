import { z } from 'zod';

/**
 * Custom provider mapping format — allows arbitrary git forges to
 * produce MappedObservation[] through simple field-path extraction.
 *
 * Lives at `~/.second-brain/providers/<name>.json`.
 * Loaded by `CustomProvider` and validated on startup.
 */

/** Verification config: how to check incoming webhooks. */
const VerificationConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('token'),
    /** Header name to read the token from (e.g., 'x-gitea-token'). */
    header: z.string().min(1),
  }),
  z.object({
    kind: z.literal('hmac'),
    /** Header name to read the HMAC signature from (e.g., 'x-hub-signature-256'). */
    header: z.string().min(1),
    /** Hash algorithm. Default: 'sha256'. */
    algorithm: z.enum(['sha256', 'sha1']).default('sha256'),
    /** Prefix before the hex digest in the header value (e.g., 'sha256='). Empty if none. */
    prefix: z.string().default(''),
  }),
]);

/**
 * Dot-notation field path for extracting a value from a JSON payload.
 * Example: "$.pull_request.user.login" → payload.pull_request.user.login
 *
 * Only supports simple property access (no arrays, no wildcards).
 * Leading "$." is optional convention; stripped before resolution.
 */
const FieldPathSchema = z.string().min(1);

/** Mapping for a pull-request-like event. */
const PREventMappingSchema = z.object({
  /** Field path to the action string (e.g., 'opened', 'closed', 'synchronize'). */
  action: FieldPathSchema,
  /** Field path to the PR/MR number (integer). */
  number: FieldPathSchema,
  /** Field path to the PR/MR title. */
  title: FieldPathSchema,
  /** Field path to the PR/MR body/description (nullable). */
  body: FieldPathSchema.optional(),
  /** Field path to the PR/MR state string. */
  state: FieldPathSchema.optional(),
  /** Field path to the source/head branch name. */
  sourceBranch: FieldPathSchema,
  /** Field path to the target/base branch name. */
  targetBranch: FieldPathSchema,
  /** Field path to the author login/username. */
  authorLogin: FieldPathSchema,
  /** Field path to the author email (optional — falls back to noreply). */
  authorEmail: FieldPathSchema.optional(),
  /** Field path to a boolean or string indicating whether the PR was merged. */
  merged: FieldPathSchema.optional(),
  /** Field path to the merged-at timestamp (ISO-8601 or empty). */
  mergedAt: FieldPathSchema.optional(),
  /** Field path to the web URL of the PR/MR. */
  webUrl: FieldPathSchema.optional(),
  /** Field path to a boolean indicating draft/WIP status. */
  draft: FieldPathSchema.optional(),
});

/** Mapping for a review/approval event. */
const ReviewEventMappingSchema = z.object({
  /** Field path to the review state (e.g., 'approved', 'changes_requested'). */
  state: FieldPathSchema,
  /** Field path to the associated PR/MR number. */
  prNumber: FieldPathSchema,
  /** Field path to the reviewer login. */
  authorLogin: FieldPathSchema,
  /** Field path to the created-at timestamp. */
  createdAt: FieldPathSchema.optional(),
});

/** Mapping for a comment event. */
const CommentEventMappingSchema = z.object({
  /** Field path to the comment body. */
  body: FieldPathSchema,
  /** Field path to the comment ID (integer or string). */
  commentId: FieldPathSchema,
  /** Field path to the associated PR/MR number. */
  prNumber: FieldPathSchema,
  /** Field path to the comment author login. */
  authorLogin: FieldPathSchema,
  /** Field path to the created-at timestamp. */
  createdAt: FieldPathSchema.optional(),
});

/**
 * Action mapping: maps the forge's action string to our canonical actions.
 * Example: { "opened": "open", "merged": "merge" }
 *
 * Our canonical actions: 'open', 'update', 'merge', 'close'
 */
const ActionMapSchema = z.record(
  z.string(),
  z.enum(['open', 'update', 'merge', 'close', 'approve', 'request_changes', 'comment']),
).optional();

/** The full custom provider mapping file. */
export const CustomProviderMappingSchema = z.object({
  /** Human-readable name of the provider (e.g., 'gitea', 'forgejo'). */
  name: z.string().min(1),
  /** Schema version for future compatibility. */
  version: z.literal(1),
  /** How to verify incoming webhook deliveries. */
  verification: VerificationConfigSchema,
  /** Header that contains the event type discriminator (e.g., 'x-gitea-event'). */
  eventTypeHeader: z.string().min(1),
  /** Delivery ID header for dedup (e.g., 'x-gitea-delivery'). Falls back to UUID generation. */
  deliveryIdHeader: z.string().optional(),
  /**
   * Event type → mapping. Key is the value of the eventTypeHeader
   * (e.g., 'pull_request', 'pull_request_review').
   */
  mappings: z.object({
    /** PR/MR lifecycle events (open, update, merge, close). */
    pull_request: PREventMappingSchema.optional(),
    /** Review/approval events. */
    review: ReviewEventMappingSchema.optional(),
    /** Comment events. */
    comment: CommentEventMappingSchema.optional(),
  }),
  /** Optional action string mapping (forge action → canonical action). */
  actionMap: ActionMapSchema,
  /**
   * Noreply email template for when author email is unavailable.
   * Use `{login}` as placeholder. Example: '{login}@noreply.gitea.example.com'
   */
  noreplyEmailTemplate: z.string().optional(),
});

export type CustomProviderMapping = z.infer<typeof CustomProviderMappingSchema>;
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;
export type PREventMapping = z.infer<typeof PREventMappingSchema>;
export type ReviewEventMapping = z.infer<typeof ReviewEventMappingSchema>;
export type CommentEventMapping = z.infer<typeof CommentEventMappingSchema>;

// Re-export sub-schemas for downstream use
export {
  VerificationConfigSchema,
  FieldPathSchema,
  PREventMappingSchema,
  ReviewEventMappingSchema,
  CommentEventMappingSchema,
  ActionMapSchema,
};

/**
 * Extract a value from a nested object using dot-notation path.
 * Example: extractField({ a: { b: 'hello' } }, '$.a.b') → 'hello'
 *
 * Returns `undefined` if the path doesn't resolve.
 */
export function extractField(obj: unknown, path: string): unknown {
  const cleaned = path.startsWith('$.') ? path.slice(2) : path;
  const parts = cleaned.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    const parsed = z.record(z.string(), z.unknown()).safeParse(current);
    if (!parsed.success) return undefined;
    current = parsed.data[part];
  }
  return current;
}
