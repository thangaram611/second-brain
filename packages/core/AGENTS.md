# @second-brain/core — Agent Instructions

Knowledge graph engine. SQLite + Drizzle ORM + FTS5 + sqlite-vec.

## Entry Point

`src/brain.ts` → `Brain` class — the single facade for all operations.

## Key Classes

| Class | File | Responsibility |
|-------|------|---------------|
| `Brain` | `src/brain.ts` | Top-level facade wrapping all managers |
| `EntityManager` | `src/storage/` | CRUD for entities (ULID generation) |
| `RelationManager` | `src/storage/` | CRUD for relations (ULID generation) |
| `GraphTraversal` | `src/graph/` | Path-finding, neighborhoods, connected components |
| `SearchEngine` | `src/search/` | FTS5 full-text + sqlite-vec vector search |
| `BitemporalQueries` | `src/temporal/` | Point-in-time and history queries |
| `DecayEngine` | `src/temporal/` | Confidence decay (read-side only) |
| `ContradictionDetector` | `src/search/` | Finds contradicting observations |
| `EmbeddingStore` | `src/embeddings/` | Optional vector storage |

## Schema

Drizzle schema: `src/schema/entities.ts`
Migrations: `src/storage/migrations/`

## Architecture Decisions

- **Confidence decay is read-side only** — never mutate stored values
- **FTS5 triggers auto-maintain `entities_fts`** — never write to it directly
- **Relations have unique constraint** on `(sourceId, targetId, type)`
- **`batchUpsert`** merges observations/tags on conflict
- **Vector search is opt-in** — pass `embeddingDimensions` to Brain constructor
- **Sync never touches `'personal'` namespace**
- **Session namespaces** use `'session:<id>'` prefix

## Testing

```bash
pnpm test              # Run all core tests
```

Tests use in-memory SQLite (`:memory:`). Instantiate `Brain` directly — no HTTP layer.
