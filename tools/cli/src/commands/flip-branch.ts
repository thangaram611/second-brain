import type { Command } from 'commander';
import type { BranchStatusPatch } from '@second-brain/types';
import { BRANCH_STATUSES, BranchStatusPatchSchema } from '@second-brain/types';
import { openBrain } from '../lib/config.js';

export function registerFlipBranchCommand(program: Command): void {
  program
    .command('flip-branch')
    .description('Manually flip branchContext.status on a branch (admin escape hatch).')
    .argument('<branch>', 'Branch name to flip (exact match)')
    .requiredOption('--status <status>', `One of: ${BRANCH_STATUSES.join(' | ')}`)
    .option('--mr <iid>', 'Optional MR/PR iid (numeric)')
    .option('--merged-at <iso>', 'ISO timestamp (when --status=merged)')
    .action(
      (
        branchName: string,
        options: { status: string; mr?: string; mergedAt?: string },
      ) => {
        let patch: BranchStatusPatch;
        try {
          patch = BranchStatusPatchSchema.parse({
            status: options.status,
            mrIid: options.mr ? Number(options.mr) : null,
            mergedAt: options.mergedAt ?? null,
          });
        } catch (err) {
          console.error(`Invalid arguments: ${(err as Error).message}`);
          process.exit(1);
        }
        const brain = openBrain();
        try {
          const result = brain.flipBranchStatus(branchName, patch);
          console.log(
            `Flipped "${branchName}" → ${patch.status}. ` +
              `entities=${result.updatedEntities} relations=${result.updatedRelations}`,
          );
        } finally {
          brain.close();
        }
      },
    );
}
