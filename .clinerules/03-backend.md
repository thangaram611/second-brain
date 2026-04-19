# Backend Patterns

## Database
- Drizzle ORM for queries. Schema: packages/core/src/schema/
- Brain class is main facade: packages/core/src/brain.ts
- Relations: unique (sourceId, targetId, type). Use createOrGet for idempotent creation
- FTS5 auto-maintained via triggers. sqlite-vec for vector KNN search

## Server
- Express 5 routes in apps/server/src/routes/
- Validate request bodies with Zod
- WebSocket broadcast after entity/relation mutations
- MCP tools in packages/mcp-server/src/tools/

## CLI
- Commander.js commands in tools/cli/src/commands/
- Register in tools/cli/src/index.ts
