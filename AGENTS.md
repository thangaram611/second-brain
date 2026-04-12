# Second Brain — Agent Instructions

This is a pnpm monorepo using Turborepo. Node.js 22+, TypeScript 5.8+ in strict mode.

## Structure

- `packages/types` — Shared TypeScript types (entity, relation, search)
- `packages/core` — Knowledge graph engine (CRUD, search, storage, temporal)
- `packages/ingestion` — Auto-growth pipeline (git, AST, conversations, GitHub, docs)
- `packages/sync` — Yjs CRDT sync layer
- `packages/mcp-server` — MCP interface (stdio + streamable HTTP)
- `apps/server` — Express REST + WebSocket server
- `apps/ui` — React web app (Vite + Tailwind + Cytoscape.js)
- `apps/relay` — y-websocket relay server
- `tools/cli` — `brain` CLI tool

## Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm check-types      # Type-check all packages
pnpm dev              # Start dev mode
```

## Conventions

- All packages use ESM (`"type": "module"`)
- IDs are ULIDs (sortable, unique)
- Timestamps are ISO 8601 strings
- SQLite via better-sqlite3, schema via Drizzle ORM
- Every entity/relation has a `namespace` field: `'personal'` for local-only, project ID for synced
- Tests use Vitest with in-memory SQLite
