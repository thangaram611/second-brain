# GitHub Copilot Instructions — Second Brain

## Project

Developer knowledge graph — pnpm monorepo with Turborepo. Node.js 22+, TypeScript 5.8+ strict mode, ESM only.

For full architecture details, see [docs/architecture.md](../docs/architecture.md).
For agent-level instructions, see [AGENTS.md](../AGENTS.md).

## Tech Stack

- **Runtime**: Node.js 22+, ESM modules only (`"type": "module"`)
- **Language**: TypeScript 5.8+ (strict mode, explicit return types, no `any`)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM, WAL mode
- **Search**: FTS5 (BM25) + sqlite-vec (cosine KNN), fused via Reciprocal Rank Fusion
- **Validation**: Zod v4 for all external inputs
- **Testing**: Vitest with in-memory SQLite (`:memory:`), globals enabled
- **Build**: tsdown (ESM bundler), tsc (type-check only)
- **Frontend**: React 19, Zustand, Cytoscape.js, Tailwind CSS, Radix UI
- **Sync**: Yjs CRDTs via Hocuspocus relay
- **IDs**: ULIDs (via ulidx). Never UUID
- **Timestamps**: ISO 8601 strings. Never unix timestamps

## Conventions

### DO
- Use named exports, re-export from package index.ts
- Use workspace imports: `@second-brain/core`, `@second-brain/types`
- Use Zod schemas for request validation in routes
- Write tests with Vitest using in-memory SQLite
- Use `batchUpsert` for bulk operations (merges observations/tags on conflict)
- Keep observations as atomic, concise facts (string arrays)
- Use try-catch with descriptive error messages

### DON'T
- Use path aliases (rely on workspace resolution)
- Use `any` type
- Import from package internals (use public API via index.ts)
- Use UUIDs (use ULIDs from ulidx)
- Use Date objects or unix timestamps in storage
- Manually write to entities_fts table (auto-maintained via triggers)
- Sync the 'personal' namespace
- Mutate stored confidence values (decay is read-side only)

## Monorepo Structure

```
packages/types      — Shared TypeScript types
packages/core       — Knowledge graph engine (Brain class)
packages/collectors — Data collectors + streaming providers
packages/ingestion  — LLM extraction + embedding pipeline
packages/sync       — Yjs CRDT sync bridge
packages/mcp-server — MCP tools (32 tools, stdio + HTTP)
apps/server         — Express 5 REST API + WebSocket (port 7430)
apps/ui             — React 19 + Cytoscape.js web app (port 5173)
apps/relay          — Hocuspocus CRDT relay (port 7421)
tools/cli           — brain CLI (Commander.js)
```

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm check-types      # Type-check everything
pnpm dev              # Start dev servers
```

## Data Model

- **Entity types** (15): concept, decision, pattern, person, file, symbol, event, tool, fact, conversation, reference, implementation, pull_request, merge_request, branch
- **Relation types** (20): relates_to, depends_on, implements, supersedes, contradicts, derived_from, authored_by, decided_in, uses, tests, contains, co_changes_with, preceded_by, blocks, reviewed_by, merged_in_mr, merged_in_pr, touches_file, owns, parallel_with
- Every entity/relation has a `namespace` field
- Bitemporal: eventTime + ingestTime
- Confidence with time-based decay (read-side only)
