/**
 * Maps raw SQLite rows (snake_case columns, JSON columns as strings) to domain
 * objects via the parse-at-boundary Zod schemas in `row-schemas.ts`.
 *
 * The public names `rawRowToEntity`/`rawRowToRelation` are preserved as the
 * exported surface; both now `.parse()` the row (validating every column against
 * its authoritative enum/shape) and THROW on a malformed row rather than
 * silently producing `undefined`/`NaN`.
 */
export { parseEntityRow as rawRowToEntity, parseRelationRow as rawRowToRelation } from './row-schemas.js';
