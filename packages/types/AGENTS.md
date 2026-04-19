# @second-brain/types — Agent Instructions

Shared TypeScript type definitions for the entire monorepo. No runtime code — types only.

## Key Files

| File | Contents |
|------|----------|
| `src/entity.ts` | `Entity` type, `ENTITY_TYPES` array (15 types), `EntityType` union |
| `src/relation.ts` | `Relation` type, `RELATION_TYPES` array (20 types), `RelationType` union |
| `src/search.ts` | `SearchResult`, `SearchOptions`, `FusedSearchOptions` |
| `src/temporal.ts` | `BitemporalRecord`, `TemporalQuery`, `HistoryEntry` |
| `src/sync.ts` | `SyncState`, `SyncMessage`, `SyncConfig` |
| `src/namespace.ts` | `Namespace` type, validation helpers |
| `src/author.ts` | `Author` type for attribution |
| `src/branch-context.ts` | `BranchContext` for git-aware operations |
| `src/index.ts` | Re-exports everything |

## Adding a New Entity Type

1. Add to `ENTITY_TYPES` array in `src/entity.ts`
2. The `EntityType` union auto-derives from the array
3. Downstream: update FTS triggers in `packages/core` if needed

## Adding a New Relation Type

1. Add to `RELATION_TYPES` array in `src/relation.ts`
2. The `RelationType` union auto-derives from the array

## Conventions

- All types use `as const` arrays with derived union types
- Every entity/relation carries `namespace`, `eventTime`, `ingestTime`
- Confidence is `0..1` float, decayed read-side only
- Observations are `string[]` — atomic facts
