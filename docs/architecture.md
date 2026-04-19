# Second Brain — Architecture

> **Shared source of truth** for the Second Brain developer knowledge graph.
> Referenced by Cursor rules, Copilot instructions, MCP tool configs, and onboarding docs.
>
> Last verified against codebase: 2025-07

---

## Table of Contents

- [1. Project Overview](#1-project-overview)
- [2. Monorepo Structure](#2-monorepo-structure)
- [3. Data Model](#3-data-model)
- [4. Core Engine — packages/core](#4-core-engine--packagescore)
- [5. Collectors & Ingestion](#5-collectors--ingestion)
- [6. MCP Server — packages/mcp-server](#6-mcp-server--packagesmcp-server)
- [7. REST API — apps/server](#7-rest-api--appsserver)
- [8. UI — apps/ui](#8-ui--appsui)
- [9. CRDT Sync — packages/sync + apps/relay](#9-crdt-sync--packagessync--appsrelay)
- [10. CLI — tools/cli](#10-cli--toolscli)
- [11. Build & Development](#11-build--development)
- [12. Key Conventions](#12-key-conventions)

---

## 1. Project Overview

Second Brain is a developer knowledge graph that automatically captures, organizes, and surfaces knowledge from coding workflows. It ingests data from git commits, code ASTs (via tree-sitter), AI conversations, GitHub/GitLab PRs and issues, and markdown documentation — then links them into a queryable graph of entities and relations.

The system supports real-time team synchronization via Yjs CRDTs, with namespace isolation between personal and shared knowledge. Search combines SQLite FTS5 full-text search with sqlite-vec vector embeddings, fused via Reciprocal Rank Fusion. A bitemporal model tracks both when events happened and when they were discovered.

Second Brain exposes its graph through multiple interfaces: a 32-tool MCP server for AI assistant integration, a REST API with WebSocket broadcasts, a React-based graph explorer UI, and a CLI with 30+ commands. It runs as a pnpm monorepo with Turborepo orchestration, targeting Node.js 22+ with TypeScript 5.8+ in strict mode, ESM throughout.

---

## 2. Monorepo Structure

```
second-brain/
├── packages/
│   ├── types/          Shared TypeScript types (entity, relation, search, sync, temporal)
│   ├── core/           Knowledge graph engine (SQLite + Drizzle ORM + FTS5 + sqlite-vec)
│   ├── ingestion/      Auto-growth pipeline (LLM extraction, embedding pipeline)
│   ├── collectors/     6 data collectors + 4 streaming providers
│   ├── sync/           Yjs CRDT sync layer (bidirectional bridge to SQLite)
│   └── mcp-server/     MCP interface (32 tools, stdio + HTTP transports)
├── apps/
│   ├── server/         Express 5 REST API + WebSocket server (port 7430)
│   ├── ui/             React 19 + Vite + Cytoscape.js + Zustand + Tailwind (port 5173)
│   └── relay/          Hocuspocus y-websocket relay (JWT auth, file persistence, port 7421)
├── tools/
│   └── cli/            `brain` CLI (Commander.js, 30+ commands)
├── docs/               Project documentation
├── turbo.json          Turborepo pipeline config
├── pnpm-workspace.yaml Workspace definition
└── vitest.base.ts      Shared Vitest config (in-memory SQLite)
```

### Dependency Graph

```
types ← core ← ingestion ← collectors
              ← sync
              ← mcp-server
              ← server (apps)
              ← cli (tools)
ui (standalone, talks to server via HTTP/WS)
relay (standalone Hocuspocus server)
```

---

## 3. Data Model

### Entity Types (15)

| Type | Description |
|------|-------------|
| `concept` | Abstract knowledge concept |
| `decision` | Architectural or design decision |
| `pattern` | Recurring code or design pattern |
| `person` | Developer or contributor |
| `file` | Source file |
| `symbol` | Code symbol (function, class, variable) |
| `event` | Noteworthy occurrence |
| `tool` | Development tool or library |
| `fact` | Discrete piece of knowledge |
| `conversation` | AI or team conversation |
| `reference` | External reference or link |
| `pull_request` | GitHub pull request |
| `merge_request` | GitLab merge request |
| `branch` | Git branch |
| `review` | Code review |

### Relation Types (20)

| Type | Description |
|------|-------------|
| `relates_to` | General association |
| `depends_on` | Dependency relationship |
| `implements` | Implementation of a concept/decision |
| `supersedes` | Newer version replaces older |
| `contradicts` | Conflicting information |
| `derived_from` | Originated from another entity |
| `authored_by` | Authorship attribution |
| `decided_in` | Decision made in a context |
| `uses` | Usage relationship |
| `tests` | Testing relationship |
| `contains` | Containment/composition |
| `co_changes_with` | Files that change together |
| `preceded_by` | Temporal ordering |
| `blocks` | Blocking dependency |
| `reviewed_by` | Code review attribution |
| `merged_in_mr` | Merged via GitLab MR |
| `merged_in_pr` | Merged via GitHub PR |
| `touches_file` | Entity references a file |
| `owns` | Ownership relationship |
| `parallel_with` | Concurrent/parallel work |

### Entity Source Types (12)

`git`, `ast`, `conversation`, `github`, `gitlab`, `manual`, `doc`, `inferred`, `personality`, `watch`, `git-hook`, `hook`

### Schema (3 tables)

| Table | Primary Key | Key Columns |
|-------|-------------|-------------|
| `entities` | `id` (ULID) | type, name, namespace, observations, properties, confidence, eventTime, ingestTime, lastAccessedAt, accessCount, sourceType, sourceRef, sourceActor, tags, createdAt, updatedAt |
| `relations` | `id` (ULID) | sourceId → entities.id, targetId → entities.id (cascade delete), type, namespace, properties, confidence, eventTime, ingestTime, sourceType, sourceRef |
| `embeddings` | `entityId` → entities.id | vector data for KNN search |

### Identity & Temporal Model

- **IDs:** ULIDs — sortable, unique, timestamp-embedded
- **Timestamps:** ISO 8601 strings throughout
- **Namespace:** `'personal'` for local-only data, project ID string for synced data
- **Bitemporal:** `eventTime` (when it happened) + `ingestTime` (when discovered)
- **Source provenance:** `sourceType`, `sourceRef`, `sourceActor` on every entity and relation

---

## 4. Core Engine — `packages/core`

### Storage

- **SQLite** via `better-sqlite3`, WAL mode for concurrent reads
- **Drizzle ORM** for type-safe schema definition and queries
- **1 versioned migration** (`001-initial.ts`)

### Indexes

| Table | Index | Columns |
|-------|-------|---------|
| entities | `idx_entities_type_namespace` | type, namespace |
| entities | `idx_entities_name` | name |
| entities | `idx_entities_namespace_updated` | namespace, updatedAt |
| entities | `idx_entities_event_time` | eventTime |
| entities | `idx_entities_ingest_time` | ingestTime |
| entities | `idx_entities_created_at` | createdAt |
| entities | `idx_entities_branch` | branch |
| entities | `idx_entities_branch_status` | branch, status |
| relations | `idx_relations_source_type` | sourceId, type |
| relations | `idx_relations_target_type` | targetId, type |
| relations | `idx_relations_namespace_type` | namespace, type |
| relations | `idx_relations_unique_edge` | unique constraint |

### Search

Three search channels fused via **Reciprocal Rank Fusion** (K=60):

| Channel | Technology | Ranking |
|---------|-----------|---------|
| `fulltext` | FTS5 virtual table | BM25 |
| `vector` | sqlite-vec extension | Cosine distance (KNN) |
| `graph` | BFS neighbor traversal | Hop distance |

### Graph Traversal

- **`getNeighbors()`** — BFS, default depth = 1 (configurable)
- **`findPath()`** — BFS with path tracking, default maxDepth = 5 (configurable)

### Confidence Decay

Read-side exponential decay applied per entity type. Rate = daily decay factor:

| Type | Rate/day | Notes |
|------|----------|-------|
| `concept` | 0.001 | Very slow decay |
| `decision` | 0.005 | Slow decay |
| `pattern` | 0.003 | Slow decay |
| `fact` | 0.01 | Moderate decay |
| `review` | 0.005 | Slow decay |
| `event` | 0.02 | Faster decay |
| `conversation` | 0.05 | Fastest decay |
| `tool` | 0.001 | Very slow decay |
| `reference` | 0.001 | Very slow decay |
| `pull_request` | 0.001 | Very slow decay |
| `merge_request` | 0.001 | Very slow decay |
| `person` | 0.0 | **Never decays** |
| `file` | 0.0 | **Never decays** |
| `symbol` | 0.0 | **Never decays** |
| `branch` | 0.0 | **Never decays** |

### Contradiction Detection

- Entities linked via `contradicts` relation
- Resolution via `supersedes` pattern (newer entity supersedes older)
- Contradiction query and resolve APIs exposed through server and MCP

---

## 5. Collectors & Ingestion

### Pipeline Phases

```
collect → upsert entities → resolve relations → upsert relations
```

### Collectors (6)

| Collector | Source | Entities Produced |
|-----------|--------|-------------------|
| `GitCollector` | Git history | person, event, branch |
| `ASTCollector` | tree-sitter (TS/JS/Go/Python/Rust/Java) | file, symbol |
| `GitHubCollector` | GitHub API | pull_request, review, person |
| `ConversationCollector` | AI conversation logs | conversation, decision, fact |
| `DocCollector` | Markdown files | concept, fact, reference |
| `FileChangeCollector` | File system events | file, event |

### Streaming Providers (4)

| Provider | Trigger | Description |
|----------|---------|-------------|
| `GitHubProvider` | Webhook / polling | GitHub event stream |
| `GitLabProvider` | Webhook / polling | GitLab event stream |
| `GitProvider` | File system watch | Local git event stream |
| `CustomProvider` | Webhook-driven | User-defined event stream |

### LLM Extraction

- Extracts decisions, facts, and patterns from prose (conversations, docs)
- Part of the `packages/ingestion` pipeline

### Embedding Pipeline

- Generates vector embeddings for entity content
- Staleness detection via content hash comparison
- Stored in `embeddings` table for sqlite-vec KNN queries

---

## 6. MCP Server — `packages/mcp-server`

### Transports

| Transport | Protocol | Port | Auth |
|-----------|----------|------|------|
| stdio | MCP over stdin/stdout | — | None (local) |
| HTTP | Streamable HTTP + WS upgrade | 7420 | Optional Bearer token (`BRAIN_AUTH_TOKEN`) |

Health check: `GET /health` (no auth required)

### Tools (32 total)

**Read Tools (15):**
`get_entity`, `search_brain`, `search_decisions`, `search_patterns`, `get_graph_stats`, `get_neighbors`, `traverse_graph`, `recall_session_context`, `get_timeline`, `timeline_around`, `get_stale`, `get_ownership`, `get_observations_by_ids`, `find_parallel_work`, `get_contradictions`

**Write Tools (12):**
`add_entity`, `add_relation`, `add_observation`, `update_entity`, `merge_entities`, `record_decision`, `record_fact`, `record_pattern`, `invalidate`, `flip_branch_status`, `dismiss_contradiction`, `resolve_contradiction`

**Pipeline Tools (5):**
`reindex`, `export_graph`, `import_graph`, `embed`, `rebuild_embeddings`

---

## 7. REST API — `apps/server`

- **Framework:** Express 5.1.0
- **Port:** 7430
- **CORS:** localhost:5173, 127.0.0.1:5173

### Endpoints (~44 routes)

#### Entity CRUD
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entities` | List entities (filtered) |
| GET | `/api/entities/:id` | Get entity by ID |
| POST | `/api/entities` | Create entity |
| PATCH | `/api/entities/:id` | Update entity |
| DELETE | `/api/entities/:id` | Delete entity |
| POST | `/api/entities/:id/observations` | Add observations |
| DELETE | `/api/entities/:id/observations` | Remove observations |
| GET | `/api/entities/:id/neighbors` | Get neighbors |

#### Relations
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/relations` | Create relation |
| GET | `/api/relations/:id` | Get relation |
| DELETE | `/api/relations/:id` | Delete relation |

#### Search & Query
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search` | Hybrid search (`?q=...`) |
| GET | `/api/query` | Graph query (GET) |
| POST | `/api/query` | Graph query (POST) |
| GET | `/api/query/ownership` | Code ownership |
| GET | `/api/query/ownership-tree` | Ownership tree |
| GET | `/api/query/parallel-work` | Parallel work detection |

#### Temporal
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/timeline` | Timeline view (`?from=...&to=...`) |
| GET | `/api/contradictions` | List contradictions |
| POST | `/api/contradictions/:id/resolve` | Resolve contradiction |

#### Sync
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/status` | Global sync status |
| GET | `/api/sync/status/:namespace` | Namespace sync status |
| POST | `/api/sync/join` | Join sync namespace |
| POST | `/api/sync/leave` | Leave sync namespace |
| GET | `/api/sync/peers/:namespace` | List peers |

#### Observation Hooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/observe/session-start` | Session started |
| POST | `/api/observe/prompt-submit` | Prompt submitted |
| POST | `/api/observe/tool-use` | Tool used |
| POST | `/api/observe/stop` | Session stopped |
| POST | `/api/observe/session-end` | Session ended |
| POST | `/api/observe/file-change` | File changed |
| POST | `/api/observe/branch-change` | Branch changed |
| POST | `/api/observe/git-event` | Git event |
| POST | `/api/observe/mr-event` | MR/PR event |
| GET | `/api/observe/counters` | Observation counters |

#### Admin
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/reindex` | Trigger reindex |
| GET | `/api/embeddings/status` | Embedding status |
| POST | `/api/rebuild-embeddings` | Rebuild all embeddings |
| POST | `/api/export` | Export graph |
| POST | `/api/import` | Import graph |

### Middleware

- **CORS** — allowed origins: `localhost:5173`, `127.0.0.1:5173`
- **Error handler** — centralized Express error handling
- **WebSocket** — broadcasts entity/relation changes for real-time UI updates

---

## 8. UI — `apps/ui`

- **React** 19.1.0 + **React Router** 7.6.0
- **State:** Zustand 5.0.5 (store-per-feature pattern, 8 stores)
- **Graph:** Cytoscape.js with 4 layouts: `cose`, `grid`, `circle`, `breadthfirst`
- **Components:** Radix UI primitives + Tailwind CSS (dark theme)

### Pages (11 routes)

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | Overview and stats |
| `/graph` | Graph Explorer | Interactive graph visualization |
| `/graph/:id` | Graph Explorer | Seeded from specific entity |
| `/search` | Search | Hybrid search interface |
| `/entities/:id` | Entity Detail | Single entity view |
| `/timeline` | Timeline | Temporal event view |
| `/decisions` | Decisions | Decision log |
| `/contradictions` | Contradictions | Contradiction management |
| `/ownership` | Ownership | Code ownership view |
| `/wip-radar` | WIP Radar | Work-in-progress detection |
| `/settings` | Settings | Configuration |

### Zustand Stores (8)

`graph-store`, `search-store`, `timeline-store`, `ownership-store`, `contradictions-store`, `stats-store`, `sync-store`, `wip-store`

### Features

- WebSocket auto-reconnect with exponential backoff
- Import/Export: JSON, JSON-LD, DOT formats

---

## 9. CRDT Sync — `packages/sync` + `apps/relay`

### Sync Layer (`packages/sync`)

- **Yjs** documents with `Y.Map` per entity and relation
- **SyncBridge:** bidirectional SQLite ↔ Y.Doc synchronization
  - Deep observers on Y.Doc changes → writes to SQLite
  - SQLite change hooks → updates to Y.Doc
  - Origin filtering to prevent echo loops
- Conflict detection on `name` and `confidence` fields
- Awareness protocol for peer presence

### Relay Server (`apps/relay`)

- **Hocuspocus** 2.13.0 relay server
- **Port:** 7421 (configurable via `RELAY_PORT`)
- **Auth:** JWT tokens (via `jsonwebtoken` 9.0.0)
  - Endpoint: `POST /auth/token`
  - Payload: `{ sub: userName, namespace, permissions: ['read', 'write'] }`
  - Expiry: 86,400 seconds (24 hours)
  - Secret: `RELAY_AUTH_SECRET` env var (required)
- **Namespace isolation:** separate Yjs documents per namespace
- **Persistence:** file-based `.ystate` binary files
  - Default directory: `~/.second-brain/relay` (configurable via `RELAY_PERSIST_DIR`)
- **WebSocket:** raw WS via `ws` 8.18.0, HTTP upgrade routed to Hocuspocus

---

## 10. CLI — `tools/cli`

Commander.js-based CLI invoked as `brain`.

### Commands (30+)

| Category | Commands |
|----------|----------|
| **Setup** | `init`, `reset`, `install-hooks`, `uninstall-hooks` |
| **Entities** | `add`, `decide`, `personal` |
| **Indexing** | `index`, `git`, `ast`, `github`, `docs`, `conversation`, `co-ingest-claude-mem` |
| **Search** | `search`, `query`, `recall` |
| **Embedding** | `embed` |
| **Sync** | `sync`, `join`, `leave`, `poll`, `tail` |
| **Export/Import** | `export`, `import` |
| **Status** | `status`, `stats`, `ownership` |
| **Branching** | `flip-branch` |
| **Watch** | `watch` |
| **Wiring** | `wire`, `unwire` |

---

## 11. Build & Development

### Toolchain

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 22.0.0 | Runtime |
| pnpm | 10.8.0 | Package manager |
| Turborepo | ^2.5.0 | Monorepo orchestration |
| TypeScript | 5.8+ | Type system (strict mode) |
| tsdown | — | ESM bundler |
| tsc | — | Type-check only (no emit in most packages) |
| Vitest | — | Test runner (in-memory SQLite) |

### Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages (turbo)
pnpm test             # Run all tests (turbo)
pnpm check-types      # Type-check all packages (turbo)
pnpm dev              # Start dev mode (all services in parallel)
pnpm clean            # Clean build artifacts
```

### Turbo Pipeline

| Task | Dependencies | Cacheable | Persistent |
|------|-------------|-----------|------------|
| `build` | `^build` (topological) | Yes (`dist/**`) | No |
| `dev` | — | No | Yes |
| `test` | `build` | Yes | No |
| `check-types` | `^build` | Yes | No |
| `lint` | — | Yes | No |
| `clean` | — | No | No |

### Dev Ports

| Service | Port | Package |
|---------|------|---------|
| REST API + WebSocket | 7430 | `apps/server` |
| UI (Vite) | 5173 | `apps/ui` |
| MCP HTTP | 7420 | `packages/mcp-server` |
| CRDT Relay | 7421 | `apps/relay` |

---

## 12. Key Conventions

| Convention | Detail |
|------------|--------|
| Module system | ESM only (`"type": "module"` in all packages) |
| IDs | ULIDs (sortable, unique, timestamp-embedded) |
| Timestamps | ISO 8601 strings |
| Validation | Zod for runtime schema validation |
| Database | SQLite via better-sqlite3, Drizzle ORM for schema |
| Namespacing | `'personal'` = local-only, project ID = synced |
| Testing | Vitest with in-memory SQLite fixtures |
| State management | Zustand (store-per-feature pattern) |
| Styling | Tailwind CSS, dark theme default |
| Graph rendering | Cytoscape.js (cose, grid, circle, breadthfirst layouts) |
| Bundling | tsdown for ESM output |

---

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `BRAIN_AUTH_TOKEN` | mcp-server | Optional Bearer token for HTTP transport |
| `BRAIN_MCP_PORT` | mcp-server | HTTP port (default: 7420) |
| `RELAY_PORT` | relay | WebSocket port (default: 7421) |
| `RELAY_AUTH_SECRET` | relay | JWT signing secret (required) |
| `RELAY_PERSIST_DIR` | relay | Yjs state directory (default: `~/.second-brain/relay`) |
