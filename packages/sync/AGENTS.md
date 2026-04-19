# @second-brain/sync — Agent Instructions

Yjs CRDT sync layer for real-time collaborative knowledge graphs.

## Entry Point

`src/sync-manager.ts` → `SyncManager` coordinates sync state.

## Key Files

| File | Purpose |
|------|---------|
| `src/sync-manager.ts` | Main sync orchestrator |
| `src/crdt/` | Yjs document bridge (entity ↔ Y.Map) |
| `src/provider/` | Sync transport providers |
| `src/relay/` | Relay server helpers |

## Architecture

- Uses **Yjs** CRDTs for conflict-free merging
- Bridge converts between `Entity`/`Relation` objects and Yjs documents
- Each namespace gets its own Yjs document
- **`'personal'` namespace is never synced** — stays local only
- JWT auth for relay connections
- `.ystate` files for persistence

## Conventions

- Namespace isolation: one Yjs doc per namespace
- Session namespaces use `'session:<id>'` prefix
- File-based persistence via `.ystate` directory
