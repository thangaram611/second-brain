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
 * "login@users.noreply.github.com". GitLab noreply is already canonical.
 */
export function canonicalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const ghMatch = lower.match(/^\d+\+([^@]+)@users\.noreply\.github\.com$/);
  if (ghMatch) return `${ghMatch[1]}@users.noreply.github.com`;
  return lower;
}
