# Phase 10 — Setup & Operations Guide

Comprehensive guide covering the full Phase 10 feature set: repository wiring,
webhook providers (GitLab / GitHub / custom), the watch daemon, personality
layer, and the UI dashboards.

---

## 1. Quick Start

### Prerequisites

| Tool    | Version | Notes                                    |
|---------|---------|------------------------------------------|
| Node.js | ≥ 22    | Required for native `EventSource` support |
| pnpm    | ≥ 9     | Workspace manager                        |
| Git     | ≥ 2.30  | For hooks and remote detection           |

### Install & Build

```bash
pnpm install && pnpm build
```

### Start the Server

Development mode (auto-reload):

```bash
pnpm dev
```

Production / single-package start:

```bash
cd apps/server && pnpm start
```

The server listens on `http://localhost:7430` by default.

### Initialize a Brain

```bash
brain init
```

Interactive wizard that creates `~/.second-brain/` and the local SQLite
database.

---

## 2. `brain wire` — Repository Wiring

`brain wire` is the one-shot command that connects a local git repository to
Second Brain. It installs git hooks, optionally registers a webhook on a remote
forge, and mints an SSE relay channel for real-time event delivery.

### Basic Usage (Local Only)

```bash
brain wire
```

What happens:

1. Installs `.git/hooks/{pre-commit,post-commit,post-merge}` to observe file
   and branch changes.
2. Installs Claude Code session hooks (skip with `--no-claude`).
3. Records the repo in `~/.second-brain/config.json` with its namespace
   mapping.

### Options

| Flag                          | Description                                          |
|-------------------------------|------------------------------------------------------|
| `--repo <path>`               | Repo root (auto-detects from cwd)                    |
| `-n, --namespace <ns>`        | Namespace for observations                           |
| `--server-url <url>`          | Server URL (default: `http://localhost:7430`)         |
| `--token <token>`             | Bearer token for server auth                         |
| `--require-project`           | Fail if no project namespace is set (CI use)         |
| `--no-claude`                 | Skip Claude Code session hook install                |
| `--skip-if-claude-mem`        | Abort if claude-mem hooks are present                |
| `--provider <name>`           | Force provider: `gitlab` or `github`                 |

### GitLab Provider

```bash
brain wire --provider gitlab
```

Auto-detects the GitLab host and project path from `git remote -v`. You can
override with explicit flags:

| Flag                          | Description                                          |
|-------------------------------|------------------------------------------------------|
| `--gitlab-url <url>`          | GitLab base URL (auto-detected from origin)          |
| `--gitlab-token <pat>`        | Personal Access Token (env: `SECOND_BRAIN_GITLAB_TOKEN`) |
| `--gitlab-project-path <p>`   | `group/subgroup/project` (auto-detected)             |

**Token requirements:** PAT with `api` scope (for webhook management + user
lookup).

What happens:

1. Resolves the GitLab project ID from the project path.
2. Mints a [smee.io](https://smee.io) relay channel for webhook forwarding.
3. Generates a webhook secret and stores it in the system keychain
   (`gitlab.webhook-token:<projectId>`).
4. Registers a webhook on the GitLab project scoped to
   `merge_requests_events`, `note_events`, and `pipeline_events`.
5. Stores the PAT in the keychain (`gitlab.pat:<host>`).

### GitHub Provider

```bash
brain wire --provider github
```

Auto-detects the owner and repo name from `git remote -v`. Override with:

| Flag                          | Description                                          |
|-------------------------------|------------------------------------------------------|
| `--github-owner <owner>`      | Repository owner (auto-detected)                     |
| `--github-repo <repo>`        | Repository name (auto-detected)                      |
| `--github-token <pat>`        | PAT (env: `SECOND_BRAIN_GITHUB_TOKEN` or `GITHUB_TOKEN`) |

**Token requirements:** Classic PAT with `repo` + `admin:repo_hook` scopes, or
fine-grained PAT with **Repository webhooks** and **Pull requests** permissions.

What happens:

1. Mints a smee.io relay channel.
2. Generates an HMAC secret and stores it in the keychain
   (`github.webhook-secret:<owner>/<repo>`).
3. Registers a webhook on the GitHub repo with HMAC-SHA256 signing, scoped to
   `pull_request`, `pull_request_review`, `pull_request_review_comment`, and
   `check_suite` events.
4. Stores the PAT in the keychain (`github.pat:github.com`).

---

## 3. `brain unwire` — Undo Wiring

```bash
brain unwire
```

Reverses the wire operation:

1. Uninstalls git hooks from the repo.
2. Unregisters the webhook on the forge provider.
3. Removes keychain entries (webhook tokens, PATs).
4. Removes the repo entry from `~/.second-brain/config.json`.

| Flag                    | Description                                          |
|-------------------------|------------------------------------------------------|
| `--repo <path>`         | Repo root                                            |
| `--remove-claude-hooks` | Also remove Claude hooks globally                    |
| `--purge`               | Signal that project observations should be purged    |
| `--force`               | Proceed past provider API failures (401, timeout)    |

If your PAT has expired, `brain unwire` exits non-zero with an actionable
error. Use `--force` to proceed — it prints the webhook ID for manual deletion.

---

## 4. `brain watch` — Daemon Operation

```bash
brain watch --repo .
```

Starts two subsystems:

### File-Change Collector

- Watches the repository for file add / change / unlink events (batched,
  debounced).
- Detects branch checkouts and merges.
- Posts observations to the server:
  - `POST /api/observe/file-change` — paths, sizes, mtimes
  - `POST /api/observe/branch-change` — from/to branches
  - `POST /api/observe/git-event` — commit info

### SSE Relay

- Connects to the smee.io channel minted during `brain wire`.
- Receives incoming webhook events (GitHub / GitLab / custom) in real-time.
- Detects the provider from headers (`x-github-event`, `x-gitlab-event`).
- Forwards events to the local server with original headers preserved.
- Auto-reconnects on network disconnect.

### Options

| Flag                     | Description                                 |
|--------------------------|---------------------------------------------|
| `--repo <path>`          | Repo root (required)                        |
| `-n, --namespace <ns>`   | Override namespace                          |
| `--server-url <url>`     | Server URL                                  |
| `--token <token>`        | Bearer token                                |
| `--author-email <email>` | Override git `user.email`                   |
| `--author-name <name>`   | Override git `user.name`                    |

---

## 5. Providers

Second Brain supports three provider types for receiving forge events.

### GitLab

- **Self-hosted support:** pass `--gitlab-url` or let it auto-detect from the
  git remote.
- **Verification:** Token-based — `X-Gitlab-Token` header checked via
  `timingSafeEqual`.
- **Webhook events:** `merge_requests_events`, `note_events`,
  `pipeline_events`.
- **Token scope:** `api` (webhook management + user lookup).

### GitHub

- **Verification:** HMAC-SHA256 — `X-Hub-Signature-256` header verified.
- **Webhook events:** `pull_request`, `pull_request_review`,
  `pull_request_review_comment`, `check_suite`.
- **Token types:** Classic PAT (`repo` + `admin:repo_hook`) or fine-grained
  PAT (repository webhooks + pull requests).
- **GitHub Enterprise:** set `--github-base-url` for GHE instances.
- **Email resolution:** Falls back to
  `${id}+${username}@users.noreply.github.com`.

### Custom Provider

For forges not natively supported (Gitea, Forgejo, etc.). See
[`docs/providers.md`](./providers.md) for the full mapping reference.

- **Mapping files:** `~/.second-brain/providers/<name>.json`
- **Generate a template:** `brain provider template --name gitea`
- **Webhook auto-registration:** not supported — create the webhook manually on
  your forge.
- **Verification:** configurable as `token` or `hmac`.

---

## 6. Personality Layer

Second Brain automatically extracts personality signals from your code review
patterns, communication style, and decision-making history.

### Personality Streams

| Stream                  | What it captures                               |
|-------------------------|------------------------------------------------|
| Communication Style     | Tone, verbosity, phrasing patterns             |
| Language Fingerprint    | Writing/code style preferences                 |
| Tech Familiarity        | Technical skill levels by domain               |
| Decision Patterns       | How you approach technical decisions            |
| Management Signals      | Leadership and team interaction patterns        |

### `brain personal` Commands

```bash
# View personality stats
brain personal stats
brain personal stats --json
brain personal stats --audit    # detailed provenance per entity

# Export personality data
brain personal export -o backup.json
brain personal export -o backup.enc --encrypt   # passphrase-protected

# Import personality data
brain personal import backup.json
brain personal import backup.enc                 # prompts for passphrase
brain personal import backup.json --reattach     # preserve cross-namespace edges
```

### Export / Import with Encryption

Encrypted exports use the `SBP1` binary format with passphrase-based
encryption:

```bash
brain personal export -o personal.enc --encrypt
# Enter passphrase (twice for confirmation)

brain personal import personal.enc
# Enter passphrase (wrong passphrase → "Decryption failed. Wrong passphrase?")
```

All commands accept `--json` for machine-readable output.

---

## 7. UI Features

The web UI is available at `http://localhost:7430` when the server is running.

| Route              | Page              | Description                                        |
|--------------------|-------------------|----------------------------------------------------|
| `/`                | Dashboard         | Overview and recent activity                       |
| `/graph`           | Graph Explorer    | Interactive knowledge graph visualization          |
| `/graph/:id`       | Graph Explorer    | Focused on a specific entity                       |
| `/search`          | Search            | Full-text + vector search                          |
| `/entities/:id`    | Entity Detail     | Single entity with observations and relations      |
| `/timeline`        | Timeline          | Temporal activity stream                           |
| `/decisions`       | Decisions         | Decision entities list                             |
| `/contradictions`  | Contradictions    | Conflicting observations                           |
| `/ownership`       | Ownership         | File ownership tree with score heatmap             |
| `/wip-radar`       | WIP Radar         | Parallel work detection + conflict cards           |
| `/settings`        | Settings          | Configuration                                      |

### Ownership Page (`/ownership`)

Displays a directory tree for the wired repository with ownership score
heatmaps. Scores reflect who has the most context on each file/directory based
on observed edits, reviews, and decisions.

**API endpoints:**
- `GET /api/query/ownership` — file-level ownership scores
- `GET /api/query/ownership-tree` — directory traversal with scores

### WIP Radar (`/wip-radar`)

Detects parallel work on the same files across different branches. Shows
conflict cards when two or more developers are editing overlapping paths.
Auto-refreshes to surface new conflicts in real time.

**API endpoint:**
- `GET /api/query/parallel-work` — parallel work detection

---

## 8. Troubleshooting

### Webhook Delivery Failures

- Verify the smee.io relay URL is reachable: visit it in a browser.
- Check that `brain watch` is running and shows `SSE relay connected`.
- On GitLab: *Settings → Webhooks → Edit → Recent Deliveries* to inspect
  responses.
- On GitHub: *Settings → Webhooks → Recent Deliveries* to inspect responses.

### Auth Errors

- GitLab: ensure the PAT has `api` scope and hasn't expired.
- GitHub: ensure the PAT has `repo` + `admin:repo_hook` (classic) or the
  correct fine-grained permissions.
- Keychain issues: `security find-generic-password -s second-brain -a
  gitlab.pat:<host>` (macOS) to verify stored credentials.

### Port Conflicts

The server defaults to port `7430`. If the port is in use:

```bash
PORT=7431 pnpm dev
```

Update `--server-url` in your `brain watch` / `brain wire` invocations
accordingly.

### Debug Mode

```bash
brain wire --provider gitlab --verbose
```

Check server logs for detailed request/response traces.

### Common Keychain Issues (macOS)

If `brain unwire` fails to remove keychain entries:

```bash
security delete-generic-password -s second-brain -a gitlab.pat:<host>
security delete-generic-password -s second-brain -a gitlab.webhook-token:<projectId>
```
