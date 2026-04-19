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

| Route file | Prefix | Purpose |
|------------|--------|---------|
| `admin.ts` | `/admin` | Health, stats, config |
| `entities.ts` | `/entities` | Entity CRUD |
| `relations.ts` | `/relations` | Relation CRUD |
| `search.ts` | `/search` | Full-text + vector search |
| `query.ts` | `/query` | Graph traversal queries |
| `observe.ts` | `/observe` | Add observations to entities |
| `sync.ts` | `/sync` | Sync state management |
| `temporal.ts` | `/temporal` | Bitemporal queries |

## Adding a New REST Endpoint

1. Create route file in `src/routes/`
2. Register the router in `src/index.ts`
3. Add Zod schemas in `src/schemas.ts` for request validation

## Conventions

- WebSocket broadcast after mutations (real-time UI updates)
- Use `brain-instance.ts` singleton — never construct Brain directly
- Zod validation middleware on all routes
