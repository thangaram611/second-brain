import { z } from 'zod';

/**
 * Lenient Zod schemas for GitHub API responses.
 * Only required fields are defined; `.passthrough()` ensures
 * extra fields from Octokit don't cause validation failures.
 */

const GitHubUserSchema = z
  .object({
    login: z.string(),
  })
  .passthrough()
  .nullable();

export const GitHubPRSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    merged_at: z.string().nullable(),
    html_url: z.string(),
    user: GitHubUserSchema,
  })
  .passthrough();

export const GitHubIssueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    html_url: z.string(),
    user: GitHubUserSchema,
    labels: z.array(
      z
        .object({
          name: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const GitHubReviewSchema = z
  .object({
    id: z.number(),
    body: z.string().nullable(),
    state: z.string(),
    html_url: z.string(),
    user: GitHubUserSchema,
    submitted_at: z.string().nullable(),
  })
  .passthrough();

export type GitHubPR = z.infer<typeof GitHubPRSchema>;
export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;
export type GitHubReview = z.infer<typeof GitHubReviewSchema>;
