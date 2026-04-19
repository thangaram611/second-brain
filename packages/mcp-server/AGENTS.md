# @second-brain/mcp-server — Agent Instructions

MCP (Model Context Protocol) server exposing 32 tools for knowledge graph operations.

## Entry Point

`src/server.ts` → `createMcpServer()` registers all tools and resources.

## Transports

- `src/stdio.ts` — stdio transport (for CLI-based MCP clients)
- `src/http.ts` — Streamable HTTP transport
- `src/transports/` — Transport helpers

## Tools (32 total)

| File | Category | Count |
|------|----------|-------|
| `src/tools/read-tools.ts` | Read operations | 15 |
| `src/tools/write-tools.ts` | Write operations | 12 |
| `src/tools/pipeline-tools.ts` | Pipeline operations | 5 |
| `src/tools/formatters.ts` | Response formatting helpers | — |

## Resources

`src/resources/` — MCP resource definitions (graph metadata, schemas).

## Adding a New MCP Tool

1. Add tool definition in the appropriate file under `src/tools/`
2. Register in `src/server.ts` via `createMcpServer()`
3. Follow existing patterns: Zod schema for input, formatter for output
