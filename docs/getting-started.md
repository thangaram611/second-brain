# Getting Started with Second Brain

A practical end-to-end guide to setting up and using the Second Brain developer knowledge graph.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Initialize Your Brain](#initialize-your-brain)
- [Index Your Codebase](#index-your-codebase)
- [Search & Query](#search--query)
- [Generate Embeddings](#generate-embeddings)
- [Record Knowledge](#record-knowledge)
- [Start Development Servers](#start-development-servers)
- [Wire a Repository](#wire-a-repository)
- [Team Sync](#team-sync)
- [Export & Import](#export--import)
- [MCP Integration (Claude Code)](#mcp-integration-claude-code)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 22+ | Required. Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to manage versions |
| **pnpm** | 10+ | Install with `corepack enable && corepack prepare pnpm@latest --activate` |
| **Git** | 2.x | For repository indexing and hooks |
| **Ollama** | *(optional)* | Local LLM for natural-language queries and enrichment — [ollama.com](https://ollama.com) |
| **API key** | *(optional)* | Anthropic, OpenAI, or Groq key — alternative to Ollama |

Verify your environment:

```bash
node -v   # v22.x.x
pnpm -v   # 10.x.x
git -v    # git version 2.x
```

---

## Installation

```bash
git clone https://github.com/<your-org>/second-brain.git
cd second-brain
pnpm install
pnpm build
```

The `brain` CLI is now available via the `tools/cli` package. You can run it directly:

```bash
pnpm --filter @second-brain/cli dev -- <command>
```

Or link it globally after building:

```bash
cd tools/cli && pnpm link --global
brain --help
```

Expected output of `brain --help`:

```
Usage: brain [options] [command]

Second Brain — developer knowledge graph CLI

Commands:
  init              Initialize a new brain
  reset             Undo init
  add               Add an entity to the brain
  decide            Record a decision
  search            Search the brain (FTS5)
  query             Natural-language query
  status            Show brain statistics
  index             Index development activity
  embed             Generate vector embeddings
  export            Export the knowledge graph
  import            Import entities + relations
  wire              Wire up a repository
  unwire            Reverse wire
  watch             Run file-change daemon
  sync              Team sync commands
  recall            Build context block
  tail              Tail live AI CLI sessions
  ...
```

---

## Initialize Your Brain

The `brain init` command sets up your personal knowledge graph.

### Interactive wizard

```bash
brain init
```

You'll be prompted for:
1. **Namespace** — default `personal` (local-only data)
2. **LLM provider** — `ollama`, `anthropic`, `openai`, or `groq`
3. **Chat model** — e.g. `llama3.2` for Ollama
4. **Embedding model** — e.g. `nomic-embed-text`

### Non-interactive (accept defaults)

```bash
brain init -y
```

Uses: Ollama provider, `personal` namespace, `llama3.2` chat model, `nomic-embed-text` embeddings.

### With Claude Code MCP wiring

```bash
brain init --wire-claude
```

Also patches `~/.claude.json` to register the Second Brain MCP server.

### All init flags

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Set default namespace |
| `--db <path>` | Custom database path |
| `-y, --yes` | Non-interactive defaults |
| `--wire-claude` | Patch `~/.claude.json` with MCP entry |

### Expected output

```
~/.second-brain/
├── config.json       # Brain configuration
└── personal.db       # SQLite knowledge graph database
```

To undo initialization:

```bash
brain reset -y                # Remove brain config & database
brain reset --wire-claude     # Also restore ~/.claude.json from backup
```

---

## Index Your Codebase

Ingest development activity into the knowledge graph. Each source creates entities and relations automatically.

### Full pipeline (git + AST)

```bash
brain index --repo .
```

Runs `GitCollector` (50 recent commits) and `ASTCollector` in sequence.

### Git history

```bash
brain index git --commits 100 --repo .
```

Creates entities for commits, files changed, and author contributions.

| Flag | Default | Description |
|------|---------|-------------|
| `--commits <n>` | `50` | Number of recent commits to process |
| `--repo <path>` | `.` | Repository root |
| `-n, --namespace <ns>` | `personal` | Target namespace |

### Code symbols (AST)

```bash
brain index ast --repo .
```

Extracts functions, classes, types, imports, and their dependency relationships.

### Markdown documentation

```bash
brain index docs --path docs/
brain index docs --path docs/ --enrich    # Use LLM to extract decisions/facts
```

| Flag | Default | Description |
|------|---------|-------------|
| `--path <paths...>` | `.` | Subdirectories to scan |
| `--enrich` | `false` | Use LLM to extract decisions, facts, and patterns |

### AI conversation logs

```bash
brain index conversation                          # All Claude Code conversations
brain index conversation --file path/to/chat.jsonl  # Specific file
brain index conversation --max 10                  # Limit to 10 conversations
```

Supports Claude Code conversations (from `~/.claude/projects/`) and generic JSONL format. Requires a working LLM provider.

| Flag | Default | Description |
|------|---------|-------------|
| `--source <path>` | `~/.claude/projects/` | Conversations directory |
| `--file <path>` | — | Specific conversation file |
| `--max <n>` | `20` | Max conversations to process |

### GitHub PRs & issues

```bash
brain index github --repo owner/name
brain index github --repo owner/name --token ghp_... --max-prs 100 --enrich
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <owner/name>` | **required** | GitHub repository |
| `--token <pat>` | `$GITHUB_TOKEN` | GitHub Personal Access Token |
| `--max-prs <n>` | `50` | Max pull requests to fetch |
| `--max-issues <n>` | `50` | Max issues to fetch |
| `--state <state>` | `all` | Filter: `open`, `closed`, or `all` |
| `--enrich` | `false` | Use LLM to extract decisions from PR descriptions |

### Expected output (example)

```
✔ GitCollector: 47 commits → 312 entities, 580 relations
✔ ASTCollector: 156 symbols → 156 entities, 203 relations
```

---

## Search & Query

### Full-text search (FTS5)

```bash
brain search "authentication"
brain search "react hooks" --type concept pattern --limit 10
```

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --type <types...>` | — | Filter by entity type |
| `-n, --namespace <ns>` | — | Filter by namespace |
| `-l, --limit <n>` | `20` | Max results |

### Natural-language query (LLM-interpreted)

```bash
brain query "How does auth work?"
brain query "What decisions were made about the database?" --limit 5
brain query --vector "authentication patterns"    # Include vector search
```

Uses the configured LLM to extract keywords, then searches via FTS5. With `--vector`, also runs semantic vector search (requires embeddings).

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --namespace <ns>` | — | Filter by namespace |
| `--limit <n>` | `10` | Max results |
| `--vector` | `false` | Also run vector/semantic search |

### Graph statistics

```bash
brain status
brain status -n personal
```

Expected output:

```
Brain Status
  Entities:    1,247
  Relations:   3,891
  Namespaces:  personal, my-project

  By type:
    concept     312
    decision     87
    pattern      45
    fact        203
    tool         92
    ...

  Relations:
    depends_on      1,204
    references        891
    implements        340
    ...
```

---

## Generate Embeddings

Vector embeddings enable semantic search (finding conceptually similar entities even when keywords don't match).

```bash
brain embed                           # Uses defaults from config
brain embed --dimensions 768          # For nomic-embed-text (Ollama)
brain embed --batch-size 32           # Smaller batches for limited memory
brain embed -n personal               # Only embed personal namespace
```

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --namespace <ns>` | — | Limit to specific namespace |
| `--batch-size <n>` | `64` | Embeddings per API request |
| `--dimensions <n>` | `768` | Embedding vector dimensions |

> **Tip:** For Ollama with `nomic-embed-text`, use `--dimensions 768`. After generating embeddings, `brain query --vector` becomes available.

---

## Record Knowledge

Manually add entities and decisions to build your knowledge graph.

### Add a concept

```bash
brain add concept "React Hooks" -o "Use deps array to control re-renders" -t react frontend
```

### Add other entity types

```bash
brain add tool "Vitest" -o "Fast unit test runner" -o "Compatible with Jest API" -t testing
brain add pattern "Repository Pattern" -o "Abstract data access behind interface" -t architecture
brain add fact "Node 22 LTS" -o "Released October 2024" -t node runtime
brain add technique "Trunk-Based Dev" -o "Short-lived branches merged daily" -t git workflow
```

Supported types: `concept`, `decision`, `pattern`, `fact`, `tool`, `technique`, `reference`, `person`, `process`.

| Flag | Description |
|------|-------------|
| `-o, --obs <observations...>` | Atomic facts (repeatable) |
| `-t, --tags <tags...>` | Tags for categorization |
| `-n, --namespace <ns>` | Namespace (default: `personal`) |

### Record a decision

```bash
brain decide "Use PostgreSQL for the main database" -c "Better concurrency than SQLite for multi-user"
brain decide "Adopt Tailwind CSS" -c "Utility-first approach reduces CSS bundle size"
```

| Flag | Description |
|------|-------------|
| `-c, --context <context>` | Reasoning behind the decision |
| `-n, --namespace <ns>` | Namespace (default: `personal`) |

---

## Start Development Servers

```bash
pnpm dev
```

This starts all services via Turborepo:

| Service | URL | Default Port | Description |
|---------|-----|-------------|-------------|
| **API Server** | `http://localhost:7430` | `7430` | REST API + WebSocket |
| **UI** | `http://localhost:5173` | `5173` | React web app (Vite dev server) |
| **Relay** | `ws://localhost:7421` | `7421` | y-websocket CRDT relay |

The UI dev server proxies `/api` and `/ws` to the API server automatically.

To start services individually:

```bash
pnpm --filter @second-brain/server dev    # API server only
pnpm --filter @second-brain/ui dev        # UI only
pnpm --filter @second-brain/relay dev     # Relay only
```

For long-lived deployments (server + relay running across reboots/logouts), use
the unit templates checked into the repo:

- **Linux production** → [docs/deployment-systemd.md](./deployment-systemd.md)
  (templates at `apps/server/systemd/` and `apps/relay/systemd/`)
- **macOS dev/personal** → [docs/deployment-launchd.md](./deployment-launchd.md)
  (templates at `apps/server/launchd/` and `apps/relay/launchd/`)

Once `apps/server/package.json` defines a `start` script, the canonical
production launch command is `pnpm --filter @second-brain/server start` (the
deployment guides cover the interim direct-`node` invocation).

---

## Wire a Repository

Wiring connects a git repository to your brain, installing hooks that automatically capture development activity.

### One-shot wire-up

```bash
brain wire --repo /path/to/project
brain wire --repo . --namespace my-project
```

This installs:
- **Git hooks** — `pre-commit`, `post-commit`, `post-checkout`
- **Claude Code session hooks** — captures AI pair-programming sessions
- **Config registration** — adds repo to `wiredRepos` in brain config

| Flag | Description |
|------|-------------|
| `--repo <path>` | Repository root (auto-detected via git) |
| `-n, --namespace <ns>` | Namespace override |
| `--server-url <url>` | Server URL for hook POST targets |
| `--token <token>` | Bearer token for authentication |
| `--no-claude` | Skip Claude Code session hook install |
| `--provider <name>` | Forge provider: `gitlab` (GitHub coming soon) |

### File-change daemon

```bash
brain watch --repo /path/to/project
brain watch --repo . --namespace my-project
```

Runs a persistent daemon that monitors file changes and branch switches, posting observations to the server in real time.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <path>` | `.` | Repository root |
| `-n, --namespace <ns>` | — | Override namespace |
| `--server-url <url>` | `http://localhost:7430` | Server URL |
| `--token <token>` | `$SECOND_BRAIN_TOKEN` | Bearer token |

### Unwire

```bash
brain unwire --repo /path/to/project
brain unwire --repo . --purge             # Also mark project entities for deletion
brain unwire --repo . --remove-claude-hooks  # Also remove Claude Code hooks
```

---

## Team Sync

Sync a project namespace across team members using the CRDT relay.

### 1. Start the relay

The relay server must be running and accessible to all team members:

```bash
RELAY_AUTH_SECRET=my-shared-secret pnpm --filter @second-brain/relay dev
```

### 2. Join a sync room

```bash
brain sync join \
  --namespace my-team-project \
  --relay ws://relay.example.com:7421 \
  --secret my-shared-secret
```

> **Note:** The `personal` namespace cannot be synced — it is reserved for local-only data.

### 3. Check sync status

```bash
brain sync status
```

Expected output:

```
Sync Status
  my-team-project
    Relay:   ws://relay.example.com:7421
    Peers:   3 connected
    Last synced: 2025-01-15T10:30:00Z
```

### 4. Leave sync

```bash
brain sync leave --namespace my-team-project
```

---

## Export & Import

### Export

```bash
brain export --format json -o brain.json                   # Full JSON export
brain export --format json -n personal -o personal.json    # Namespace-filtered
brain export --format json-ld -o brain.jsonld              # Schema.org-aligned JSON-LD
brain export --format dot | dot -Tsvg > graph.svg          # Graphviz visualization
brain export --format dot | dot -Tpng > graph.png          # PNG visualization
```

| Format | Import? | Description |
|--------|---------|-------------|
| `json` | ✅ | Flat `{ entities: [...], relations: [...] }` |
| `json-ld` | ✅ | Schema.org-aligned linked data |
| `dot` | ❌ | Graphviz DOT (export only) |

### Import

```bash
brain import brain.json                             # Auto-detect format, upsert strategy
brain import brain.json --strategy merge            # Skip existing entities
brain import brain.json --strategy replace          # Clear namespace first, then import
brain import brain.jsonld --format json-ld          # Explicit format
brain import brain.json -n imported-data            # Override namespace
```

| Strategy | Behavior |
|----------|----------|
| `upsert` *(default)* | Update existing entities, create new ones |
| `merge` | Skip entities that already exist |
| `replace` | Clear the target namespace first, then import |

### Personal namespace backup

```bash
brain personal export -o backup.json                # Export personal namespace
brain personal export -o backup.enc --encrypt       # Encrypted export
brain personal import backup.json                   # Restore
brain personal stats                                # View personal namespace statistics
brain personal stats --audit                        # Detailed provenance per entity
```

---

## MCP Integration (Claude Code)

Second Brain exposes a Model Context Protocol (MCP) server with **30 tools** that Claude Code (and other MCP clients) can call directly.

### Automatic setup

```bash
brain init --wire-claude
```

This patches `~/.claude.json` to register the `second-brain-mcp` server.

### Manual setup

Add to your MCP configuration (e.g., `~/.claude.json` or VS Code MCP settings):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "node",
      "args": ["/path/to/second-brain/packages/mcp-server/dist/index.mjs"],
      "env": {
        "BRAIN_DB_PATH": "~/.second-brain/personal.db"
      }
    }
  }
}
```

### Available MCP tools (30 total)

**Read tools (15):**

| Tool | Description |
|------|-------------|
| `search_brain` | Full-text search the knowledge graph |
| `get_entity` | Get entity by ID with relations |
| `get_neighbors` | Get connected entities (multi-hop) |
| `traverse_graph` | Find paths between entities |
| `search_decisions` | Find decision entities |
| `search_patterns` | Find recurring patterns |
| `get_graph_stats` | Knowledge graph statistics |
| `get_contradictions` | List unresolved contradictions |
| `get_timeline` | View knowledge changes over time |
| `recall_session_context` | Surface memory for current session |
| `find_parallel_work` | Detect developer collisions |
| `get_ownership` | Get file ownership scores |
| `timeline_around` | Get timeline around an event |
| `get_observations_by_ids` | Batch fetch observations |
| `get_stale` | Find stale entities |

**Write tools (12):**

| Tool | Description |
|------|-------------|
| `add_entity` | Create a new entity |
| `add_relation` | Create a relationship between entities |
| `add_observation` | Append an atomic fact to an entity |
| `record_decision` | Record a decision with context |
| `record_pattern` | Record a recurring pattern |
| `record_fact` | Record a discrete fact |
| `update_entity` | Update an existing entity |
| `merge_entities` | Merge two entities into one |
| `invalidate` | Soft-delete an entity |
| `resolve_contradiction` | Resolve a contradiction (pick winner) |
| `dismiss_contradiction` | Dismiss a contradiction |
| `flip_branch_status` | Manually change branch status |

**Pipeline tools (3):**

| Tool | Description |
|------|-------------|
| `reindex` | Rebuild FTS5 search index |
| `export_graph` | Export knowledge graph (JSON, JSON-LD, DOT) |
| `import_graph` | Import graph data |

### MCP transport modes

| Mode | URL | Auth |
|------|-----|------|
| **stdio** | — | N/A (local process) |
| **HTTP** | `http://localhost:7420/mcp` | Bearer token (`BRAIN_AUTH_TOKEN`) |

---

## Environment Variables

All environment variables with their defaults and descriptions.

### LLM & Embedding Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_LLM_PROVIDER` | `ollama` | LLM provider: `ollama`, `anthropic`, `openai`, `groq` |
| `BRAIN_LLM_MODEL` | — | Chat model name (e.g., `llama3.2`) |
| `BRAIN_LLM_BASE_URL` | `http://localhost:11434` | LLM API base URL |
| `BRAIN_LLM_API_KEY` | — | API key for cloud LLM providers |
| `BRAIN_EMBEDDING_MODEL` | — | Embedding model (e.g., `nomic-embed-text`) |
| `BRAIN_EMBEDDING_PROVIDER` | — | Embedding provider (defaults to LLM provider) |
| `BRAIN_EMBEDDING_BASE_URL` | — | Embedding API base URL |
| `BRAIN_EMBEDDING_API_KEY` | — | API key for embedding provider |
| `BRAIN_EMBEDDING_DIMS` | `768` | Embedding vector dimensions |

### Database & Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_DB_PATH` | `~/.second-brain/personal.db` | SQLite database file path |
| `BRAIN_HOOK_LOG_DIR` | `~/.second-brain` | Directory for git hook logs |
| `RELAY_PERSIST_DIR` | `~/.second-brain/relay` | Relay CRDT persistence directory |

### Service Ports

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_API_PORT` | `7430` | REST API server port |
| `BRAIN_MCP_PORT` | `7420` | MCP server HTTP port |
| `RELAY_PORT` | `7421` | Relay WebSocket + HTTP port |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_AUTH_TOKEN` | — | Bearer token for API authentication |
| `RELAY_AUTH_SECRET` | — | **Required for relay** — shared secret for sync authentication |
| `GITHUB_TOKEN` | — | GitHub PAT for `brain index github` |
| `GITLAB_TOKEN` | — | GitLab PAT for provider integration |
| `SECOND_BRAIN_TOKEN` | — | Auth token for git hook daemon |

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SECOND_BRAIN_SERVER_URL` | `http://localhost:7430` | Server URL for CLI/hooks |
| `SECOND_BRAIN_RELAY_URL` | — | Custom relay URL |
| `BRAIN_PROMOTION_CONFIDENCE_MIN` | `0.6` | Minimum confidence for entity promotion |
| `SESSION_RETENTION_DAYS` | `30` | Session data retention (days) |
| `PERSONALITY_ENABLED` | `true` | Enable personality extraction |
| `PERSONALITY_EXTRACT_INTERVAL_MS` | `86400000` | Personality extraction interval (ms) |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_CLAUDE_MEM_INGEST` | `false` | Enable claude-mem co-ingestion |
| `SECOND_BRAIN_ALLOW_PLAINTEXT_PAT` | — | Set to `1` to allow plaintext PAT storage |
| `SERVE_UI` | `false` | Serve UI static files from relay |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIN_LOG_LEVEL` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `BRAIN_LOG_FORMAT` | — | Set to `json` for structured logging |
| `NODE_ENV` | — | Set to `production` for JSON log format |

---

## Troubleshooting

### `brain: command not found`

The CLI isn't linked globally. Either:

```bash
# Option 1: Link globally
cd tools/cli && pnpm link --global

# Option 2: Run via pnpm
pnpm --filter @second-brain/cli dev -- <command>

# Option 3: Run the built binary directly
node tools/cli/dist/index.mjs <command>
```

### Ollama connection errors

```
Error: Failed to connect to LLM provider
```

Make sure Ollama is running and the required models are pulled:

```bash
ollama serve                          # Start Ollama (if not running)
ollama pull llama3.2                  # Chat model
ollama pull nomic-embed-text          # Embedding model
```

### `brain query` returns no results

1. **Check if data exists:** Run `brain status` to verify entities exist
2. **Check LLM config:** `brain query` requires a working LLM provider for keyword extraction
3. **Fallback:** Use `brain search` for direct FTS5 search (no LLM required)

### `brain query --vector` fails

Vector search requires embeddings. Generate them first:

```bash
brain embed --dimensions 768
```

### Database locked errors

```
Error: SQLITE_BUSY: database is locked
```

Only one write process should access the database at a time. Stop any running `brain watch` daemons or server instances before running write-heavy CLI commands.

### Relay authentication failures

```
Error: Authentication failed
```

Ensure `RELAY_AUTH_SECRET` matches between the relay server and all connecting clients:

```bash
# Server
RELAY_AUTH_SECRET=my-secret pnpm --filter @second-brain/relay dev

# Client
brain sync join --namespace proj --relay ws://localhost:7421 --secret my-secret
```

### GitHub indexing fails with 401

```
Error: GitHub API returned 401
```

Set a valid GitHub Personal Access Token:

```bash
export GITHUB_TOKEN=ghp_your_token_here
brain index github --repo owner/name
```

The token needs `repo` scope (or `public_repo` for public repositories).

### Port already in use

```
Error: EADDRINUSE: address already in use :::7430
```

Another process is using the port. Find and stop it, or use a different port:

```bash
lsof -i :7430                        # Find the process
BRAIN_API_PORT=7431 pnpm dev          # Use alternate port
```

### MCP server not recognized by Claude Code

1. Verify `~/.claude.json` has the MCP entry:
   ```bash
   cat ~/.claude.json | grep second-brain
   ```
2. Re-run wiring:
   ```bash
   brain init --wire-claude
   ```
3. Restart Claude Code after config changes

### Reset everything

```bash
brain reset -y --wire-claude          # Remove brain config, DB, and Claude MCP entry
```

This deletes `~/.second-brain/` and restores `~/.claude.json` from backup.
