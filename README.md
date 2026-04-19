# 🧠 Second Brain

A developer knowledge graph that automatically captures, organizes, and surfaces knowledge from your coding workflow.

## Features

- **Auto-indexing** — Git commits, code AST (Tree-sitter), AI conversations, GitHub PRs/issues, markdown docs
- **Hybrid search** — Full-text search (FTS5/BM25) + semantic vector search (sqlite-vec), fused via Reciprocal Rank Fusion
- **Graph visualization** — Interactive Cytoscape.js UI with 4 layout algorithms
- **Real-time sync** — Team collaboration via Yjs CRDTs with namespace isolation
- **MCP server** — 32-tool Model Context Protocol server for AI assistant integration (Claude, etc.)
- **Bitemporal tracking** — Event time + discovery time for full knowledge history
- **Confidence decay** — Automatic staleness detection with configurable half-life
- **Contradiction detection** — Identifies and helps resolve conflicting knowledge
- **Code intelligence** — File ownership scoring and WIP parallel work radar
- **Export/Import** — JSON, JSON-LD, and Graphviz DOT formats

## Architecture

```
Data Sources         Collectors          Ingestion Pipeline       Core Engine (SQLite)
┌──────────┐      ┌──────────────┐      ┌──────────────────┐      ┌──────────────┐
│ Git      │─────▶│ Git          │─────▶│                  │─────▶│ Entities     │
│ Code     │─────▶│ AST          │      │  LLM-powered     │      │ Relations    │
│ GitHub   │─────▶│ GitHub       │      │  entity/relation  │      │ Search (FTS) │
│ Markdown │─────▶│ File watcher │      │  extraction       │      │ Vectors      │
│ Convos   │─────▶│ Conversation │      │                  │      │ Temporal     │
└──────────┘      └──────────────┘      └──────────────────┘      └──────┬───────┘
                                                                         │
                                      ┌──────────────────────────────────┤
                                      │                                  │
                               ┌──────▼───────┐                  ┌──────▼───────┐
                               │ Server       │                  │ MCP Server   │
                               │ REST + WS    │                  │ 32 tools     │
                               └──────┬───────┘                  └──────────────┘
                                      │
                        ┌─────────────┼─────────────┐
                        │             │             │
                 ┌──────▼──────┐ ┌───▼────┐ ┌──────▼──────┐
                 │ UI          │ │ CLI    │ │ Sync        │
                 │ React +     │ │ brain  │ │ Yjs CRDT ↔  │
                 │ Cytoscape   │ │ command│ │ Relay       │
                 └─────────────┘ └────────┘ └─────────────┘
```

## Quick Start

```bash
# Install dependencies and build
pnpm install && pnpm build

# Initialize a knowledge graph
brain init

# Index a repository
brain index --repo .

# Search your knowledge
brain search "your query"

# Start the UI (localhost:5173)
pnpm dev
```

## Monorepo Structure

| Package | Path | Description | Key Tech |
|---------|------|-------------|----------|
| `@second-brain/types` | `packages/types` | Shared TypeScript types and Zod schemas | Zod |
| `@second-brain/core` | `packages/core` | Knowledge graph engine (CRUD, search, storage, temporal) | better-sqlite3, Drizzle ORM, sqlite-vec |
| `@second-brain/collectors` | `packages/collectors` | Data collectors (Git, AST, GitHub, file system) | Tree-sitter, Octokit, simple-git, chokidar |
| `@second-brain/ingestion` | `packages/ingestion` | LLM-powered entity/relation extraction pipeline | Vercel AI SDK, Ollama |
| `@second-brain/sync` | `packages/sync` | Real-time CRDT sync layer with namespace isolation | Yjs, Hocuspocus |
| `@second-brain/mcp-server` | `packages/mcp-server` | MCP server for AI assistant integration | MCP SDK, Express |
| `@second-brain/server` | `apps/server` | REST API + WebSocket server | Express, ws |
| `@second-brain/ui` | `apps/ui` | Interactive graph visualization web app | React 19, Cytoscape.js, Radix UI, Tailwind |
| `@second-brain/relay` | `apps/relay` | Yjs WebSocket relay for team sync | Hocuspocus, ws |
| `@second-brain/cli` | `tools/cli` | `brain` CLI tool | Commander, clack |

## Commands

### Workspace

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages
pnpm test             # Run all tests (Vitest)
pnpm check-types      # Type-check all packages
pnpm dev              # Start all dev servers
pnpm clean            # Clean build artifacts
```

### CLI (`brain`)

```bash
brain init             # Initialize a new knowledge graph
brain index            # Index a repository (git, AST, docs)
brain search <query>   # Search entities and relations
brain query <cypher>   # Run a graph query
brain add              # Add an entity manually
brain decide           # Resolve contradictions
brain embed            # Generate embeddings for vector search
brain watch            # Watch for file changes and auto-index
brain wire             # Auto-detect and create relations
brain sync             # Sync with a team relay
brain export           # Export graph (JSON, JSON-LD, DOT)
brain import           # Import graph data
```

## Documentation

- [Architecture](docs/architecture.md) — Technical deep-dive into the system design
- [Getting Started](docs/getting-started.md) — End-to-end usage guide
- [API Reference](docs/api-reference.md) — REST API, MCP tools, and CLI reference
- [Providers](docs/providers.md) — GitHub/GitLab integration setup

## AI Tool Integration

Second Brain provides context files for major AI coding assistants:

| Tool | Config File | Status |
|------|-------------|--------|
| Claude Code | `CLAUDE.md` + `AGENTS.md` | ✅ |
| GitHub Copilot | `.github/copilot-instructions.md` | ✅ |
| Cursor | `.cursor/rules/*.mdc` | ✅ |
| Windsurf | `.windsurfrules` | ✅ |
| Cline | `.clinerules/` | ✅ |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ |
| Language | TypeScript 5.8+ (strict mode, ESM) |
| Build | Turborepo, tsdown |
| Database | SQLite via better-sqlite3 |
| ORM | Drizzle ORM |
| Search | FTS5 (BM25) + sqlite-vec (vector) |
| LLM | Vercel AI SDK (Ollama, OpenAI, Anthropic, Groq) |
| Frontend | React 19, Vite, Tailwind CSS, Radix UI |
| Visualization | Cytoscape.js |
| Sync | Yjs CRDTs, Hocuspocus |
| IDs | ULIDs (sortable, unique) |
| Package Manager | pnpm 10 |

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `ollama` | LLM provider (`ollama`, `anthropic`, `openai`, `groq`) |
| `LLM_MODEL` | `llama3.2` | Model for entity extraction |
| `LLM_EMBEDDING_MODEL` | `nomic-embed-text` | Model for vector embeddings |
| `SERVER_PORT` | `7420` | REST API server port |
| `RELAY_PORT` | `7421` | Yjs relay server port |
| `UI_PORT` | `7422` | Web UI dev server port |
| `GITHUB_TOKEN` | — | GitHub PAT for PR/issue indexing |

See [Getting Started](docs/getting-started.md) for the full configuration reference.

## Development

```bash
# Start all dev servers (API, UI, relay)
pnpm dev

# Run tests
pnpm test

# Type-check
pnpm check-types

# Build everything
pnpm build
```

## License

[MIT](LICENSE)