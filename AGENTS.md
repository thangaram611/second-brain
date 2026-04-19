# Second Brain — Agent Instructions

Developer knowledge graph. pnpm monorepo, Turborepo, Node.js 22+, TypeScript 5.8+ strict, ESM only.

Each package/app has its own AGENTS.md with package-specific instructions.

## Monorepo Map

```
packages/types      → Shared TS types
packages/core       → Graph engine (SQLite + Drizzle + FTS5 + sqlite-vec)
packages/collectors → Data collectors + streaming providers
packages/ingestion  → LLM extraction + embedding pipeline
packages/sync       → Yjs CRDT sync bridge
packages/mcp-server → MCP tools (32 tools, stdio + HTTP)
apps/server         → Express 5 REST + WebSocket (:7430)
apps/ui             → React 19 + Cytoscape.js + Zustand (:5173)
apps/relay          → Hocuspocus CRDT relay (:7421)
tools/cli           → brain CLI (Commander.js)
```

## Commands

```bash
pnpm install / build / test / check-types / lint / dev / clean
```

Per-package: `cd <pkg> && pnpm test|build|dev`

## Conventions

- ESM only (`"type": "module"`), `.mjs`/`.d.mts` output, `tsdown` for builds
- ULIDs via `ulidx` for IDs — never UUID
- ISO 8601 strings for timestamps — never unix/Date
- SQLite (better-sqlite3) + Drizzle ORM, WAL mode
- Zod v4 for external input validation
- Namespace on all entities/relations: `'personal'` = local, project ID = synced
- Vitest + in-memory SQLite (`:memory:`) for tests
- Named exports, re-export from package `index.ts`
- Workspace imports (`@second-brain/core`, `@second-brain/types`)
- Strict mode, no `any`, no path aliases

## Data Model

- **15 entity types**: concept, decision, pattern, person, file, symbol, event, tool, fact, conversation, reference, pull_request, merge_request, branch, review
- **20 relation types**: relates_to, depends_on, implements, supersedes, contradicts, derived_from, authored_by, decided_in, uses, tests, contains, co_changes_with, preceded_by, blocks, reviewed_by, merged_in_mr, merged_in_pr, touches_file, owns, parallel_with

Defined in `packages/types/src/entity.ts` and `packages/types/src/relation.ts`.

## Docs

- [docs/architecture.md](./docs/architecture.md) — Full technical architecture
- [docs/getting-started.md](./docs/getting-started.md) — Usage guide
- [docs/api-reference.md](./docs/api-reference.md) — REST API + MCP + CLI reference
