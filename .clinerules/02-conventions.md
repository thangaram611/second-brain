# Coding Conventions

## Always
- ESM only ("type": "module"). Named exports
- ULIDs for IDs (via ulidx). ISO 8601 for timestamps
- Workspace imports: @second-brain/core, @second-brain/types
- Zod v4 for external input validation
- SQLite via better-sqlite3 + Drizzle ORM (WAL mode)
- Vitest with in-memory SQLite for tests
- Namespace field on entities/relations: 'personal' = local, project ID = synced
- batchUpsert for bulk operations (merges observations/tags)
- Try-catch with descriptive error messages

## Never
- Use `any`, path aliases, UUIDs, unix timestamps
- Write to entities_fts (auto-maintained via triggers)
- Mutate stored confidence (decay is read-side only)
- Sync 'personal' namespace
- Import from package internals
