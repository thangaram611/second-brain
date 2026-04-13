import { migration001 } from './001-initial.js';
import { migration002 } from './002-branch-context.js';
import type { Migration } from './runner.js';

export { runMigrations } from './runner.js';
export type { Migration } from './runner.js';

/**
 * All known migrations, in ascending version order. Append new migrations
 * here; do not renumber existing ones.
 */
export const ALL_MIGRATIONS: ReadonlyArray<Migration> = [migration001, migration002];
