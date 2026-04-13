import { z } from 'zod';

export const BRANCH_STATUSES = ['wip', 'merged', 'abandoned'] as const;

export const BranchContextSchema = z.object({
  branch: z.string().min(1),
  status: z.enum(BRANCH_STATUSES),
  mrIid: z.number().int().nullable().optional(),
  mergedAt: z.string().datetime().nullable().optional(),
});

export type BranchContext = z.infer<typeof BranchContextSchema>;

export const BranchStatusPatchSchema = z.object({
  status: z.enum(BRANCH_STATUSES),
  mrIid: z.number().int().nullable().optional(),
  mergedAt: z.string().datetime().nullable().optional(),
});

export type BranchStatusPatch = z.infer<typeof BranchStatusPatchSchema>;
