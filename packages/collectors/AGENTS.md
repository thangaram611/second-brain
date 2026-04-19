# @second-brain/collectors — Agent Instructions

Data collectors and streaming providers that feed the knowledge graph.

## Entry Point

`src/pipeline/runner.ts` → `PipelineRunner` with `register()` and `run()`.

## Collectors (6)

| Collector | Directory | What it collects |
|-----------|-----------|-----------------|
| `git` | `src/git/` | Commits, branches, file history |
| `ast` | `src/ast/` | Code symbols, dependencies, structure |
| `github` | `src/github/` | Issues, PRs, reviews, comments |
| `gitlab` | `src/gitlab/` | MRs, issues, pipelines |
| `conversation` | `src/conversation/` | Chat/conversation transcripts |
| `docs` | `src/docs/` | Documentation files (markdown, etc.) |

## Providers (5)

| Provider | Directory | Transport |
|----------|-----------|-----------|
| `custom` | `src/providers/` | Programmatic API |
| `git` | `src/providers/` | Git hooks / polling |
| `github` | `src/providers/` | GitHub webhooks |
| `gitlab` | `src/providers/` | GitLab webhooks |
| `webhook-relay` | `src/providers/` | Generic webhook relay |

## Adding a New Collector

1. Implement the `Collector` interface in a new `src/<name>/` directory
2. Register in `src/pipeline/runner.ts`

## Other Directories

- `src/extraction/` — LLM-based entity extraction helpers
- `src/git-context/` — Git context resolution
- `src/realtime/` — Real-time event streaming
- `src/watch/` — File system watchers
