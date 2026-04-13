import { z } from 'zod';

/** Minimal Zod schemas for the GitLab REST fields we consume. */

const GitLabUserSchema = z
  .object({
    username: z.string(),
    name: z.string().optional(),
  })
  .passthrough();

const GitLabLabelSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);

export const GitLabMergeRequestSchema = z
  .object({
    id: z.number(),
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    author: GitLabUserSchema.nullable().optional(),
    web_url: z.string(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    labels: z.array(GitLabLabelSchema).optional(),
  })
  .passthrough();

export const GitLabIssueSchema = z
  .object({
    id: z.number(),
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    author: GitLabUserSchema.nullable().optional(),
    web_url: z.string(),
    labels: z.array(GitLabLabelSchema).optional(),
  })
  .passthrough();

export type GitLabMergeRequest = z.infer<typeof GitLabMergeRequestSchema>;
export type GitLabIssue = z.infer<typeof GitLabIssueSchema>;

/** Normalise a label (which GitLab returns as either a string or an object). */
export function labelName(label: string | { name: string }): string {
  return typeof label === 'string' ? label : label.name;
}
