# tools/cli — Agent Instructions

`brain` CLI tool built with Commander.js for interacting with the knowledge graph.

## Entry Point

`src/index.ts` → Commander program. Commands in `src/commands/`.

## Commands (18)

| File | Command(s) | Purpose |
|------|-----------|---------|
| `init-reset.ts` | `init`, `reset` | Initialize/reset brain database |
| `add.ts` | `add` | Add entities manually |
| `decide.ts` | `decide` | Record decisions |
| `recall.ts` | `recall` | Recall entity by name |
| `search.ts` | `search` | Full-text search |
| `query.ts` | `query` | Graph traversal queries |
| `index-cmd.ts` | `index` | Run collector pipelines |
| `embed.ts` | `embed` | Generate embeddings |
| `export-import.ts` | `export`, `import` | JSON export/import |
| `status.ts` | `status` | Show brain status/stats |
| `sync.ts` | `sync` | Manage sync state |
| `wire-unwire.ts` | `wire`, `unwire` | Connect/disconnect MCP |
| `watch.ts` | `watch` | File system watcher |
| `tail.ts` | `tail` | Stream recent changes |
| `hooks.ts` | `hooks` | Manage git hooks |
| `flip-branch.ts` | `flip-branch` | Switch branch context |
| `ownership-cmd.ts` | `ownership` | Entity ownership management |
| `personal-cmd.ts` | `personal` | Personal namespace operations |

## Adding a New CLI Command

1. Create command file in `src/commands/`
2. Export a function that takes the Commander `program` object
3. Register in `src/index.ts`

## Other Key Files

- `src/keychain.ts` — Credential storage
- `src/personal-crypto.ts` — Encryption for personal namespace
- `src/git-context-daemon.ts` — Background git context tracking
- `src/sse-relay.ts` — SSE relay for real-time events
- `src/lib/` — Shared CLI utilities
