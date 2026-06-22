# apps/server — Agent Instructions

Express 5 REST API + WebSocket server for the knowledge graph.

## Entry Point

`src/index.ts` → Express 5 app. Port **7430** (`BRAIN_API_PORT` env var).

## Key Files

| File | Purpose |
|------|---------|
| `src/app.ts` | Express app setup (middleware, error handling) |
| `src/brain-instance.ts` | Singleton Brain instance |
| `src/routes/` | Route modules |
| `src/schemas.ts` | Zod request/response schemas |
| `src/middleware/` | Auth, validation, error middleware |
| `src/services/` | Business logic services |
| `src/ws/` | WebSocket broadcast setup |
| `src/hooks/` | Lifecycle hooks |

## Routes

Wired in `src/routes/index.ts` via `registerRoutes(app, brain, options)`. Each
module is mounted with `app.use(...)` and declares its own full `/api/...`
paths — there is no prefix mounting. `GET /health` is defined directly in
`src/app.ts`.

| Route module | Key paths | Purpose |
|--------------|-----------|---------|
| `auth.ts` | `/api/auth/{redeem-invite,login,logout,whoami,rotate}` | Identity & session auth |
| `admin.ts` | `/api/admin/{invites,tokens}`, `/api/{reindex,embeddings/status,export,import,rebuild-embeddings}`, `POST /api/query` | Admin ops, pipeline triggers, NL query (`requireAdmin`) |
| `entities.ts` | `/api/entities*` (+ `/observations`, `/neighbors`) | Entity CRUD |
| `relations.ts` | `/api/relations*` | Relation CRUD |
| `search.ts` | `/api/search`, `/api/stats` | FTS + vector search, graph stats |
| `query.ts` | `/api/query/{ownership,ownership-tree,parallel-work}` | Code-intelligence queries |
| `observe.ts` | `/api/observe/*` | Hook + forge event ingestion |
| `sync.ts` | `/api/sync/*` | Sync state management |
| `temporal.ts` | `/api/{timeline,contradictions,stale,decisions,temporal/entities}` | Bitemporal queries |

## Adding a New REST Endpoint

1. Create a route module in `src/routes/` returning a router with full `/api/...` paths
2. Mount it in `src/routes/index.ts` (`registerRoutes`) — not `src/index.ts`
3. Add Zod schemas in `src/schemas.ts` for request validation

## Conventions

- WebSocket broadcast after mutations (real-time UI updates)
- Use `brain-instance.ts` singleton — never construct Brain directly
- Zod validation middleware on all routes
