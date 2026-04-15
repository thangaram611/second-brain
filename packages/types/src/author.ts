import { z } from 'zod';

export const AuthorSchema = z.object({
  canonicalEmail: z.string().email(),
  displayName: z.string().min(1).optional(),
  aliases: z.array(z.string()).default([]),
});

export type Author = z.infer<typeof AuthorSchema>;

/**
 * Canonicalize an email so one `person` entity covers a user across forges.
 * GitHub noreply aliases: "1234567+login@users.noreply.github.com" →
 * "login@users.noreply.github.com". GitLab noreply
 * (`login@users.noreply.gitlab.com`) is already canonical — pass through.
 *
 * Throws on empty input so callers never silently stamp `source.actor`
 * with an empty string.
 */
export function canonicalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  if (lower.length === 0) throw new Error('canonicalizeEmail: empty email');
  const ghMatch = lower.match(/^\d+\+([^@]+)@users\.noreply\.github\.com$/);
  if (ghMatch) return `${ghMatch[1]}@users.noreply.github.com`;
  return lower;
}

/**
 * Canonical noreply address for a GitLab username — used when the webhook
 * only exposes `username` (email is private on most instances). Mirrors
 * GitHub's `<login>@users.noreply.github.com` convention, but GitLab uses
 * the numeric-prefixed form `<id>-<login>@users.noreply.gitlab.com` on
 * gitlab.com; we normalize to the bare `<login>@users.noreply.gitlab.com`
 * form so dedup aligns with whatever the user publicizes.
 */
export function gitlabNoreplyEmail(username: string): string {
  return `${username.toLowerCase()}@users.noreply.gitlab.com`;
}
