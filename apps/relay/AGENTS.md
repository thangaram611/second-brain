# apps/relay — Agent Instructions

Hocuspocus CRDT relay server for Yjs document synchronization.

## Entry Point

`src/index.ts` → `createRelayServer()`. Port **7421** (`RELAY_PORT` env var).

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Hocuspocus server configuration |
| `src/auth.ts` | JWT authentication for relay connections |
| `src/persistence.ts` | File-based `.ystate` persistence |

## Architecture

- Built on Hocuspocus (y-websocket compatible)
- JWT auth validates namespace access
- Each namespace → separate Yjs document
- File persistence via `.ystate` directory
- `'personal'` namespace connections are rejected
