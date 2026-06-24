import { monotonicFactory } from 'ulidx';

/**
 * Process-wide monotonic ULID generator for graph node/edge ids.
 *
 * Plain `ulid()` re-randomizes the 80-bit suffix on every call, so two ids
 * minted in the same millisecond have no defined relative order. That breaks
 * `ORDER BY id` as a creation-order tiebreaker — exactly what entity/relation
 * listing relies on when many rows share an `updatedAt` millisecond.
 *
 * The monotonic factory instead increments the suffix within a millisecond (and
 * stays ordered even if the wall clock steps backwards), so ids are strictly
 * increasing in creation order. This is the "lexicographically sortable"
 * guarantee ULIDs exist to provide. A single shared instance keeps entities and
 * relations each individually monotonic across the whole process.
 */
const nextUlid = monotonicFactory();

export function newId(): string {
  return nextUlid();
}
