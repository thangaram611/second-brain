# Provider Reference

Second Brain supports three provider types for receiving forge webhook events:
**GitLab**, **GitHub**, and **Custom** (for Gitea, Forgejo, or any other git
forge). Each provider handles webhook registration, delivery verification, and
event mapping to the internal observation model.

---

## GitLab

### Self-Hosted Support

GitLab self-hosted instances are fully supported. The base URL is auto-detected
from the git remote, or can be set explicitly:

```bash
brain wire --provider gitlab --gitlab-url https://gitlab.example.com
```

### Token Requirements

| Scope | Purpose                                  |
|-------|------------------------------------------|
| `api` | Webhook management, user lookup, MR API |

Set via flag or environment variable:

```bash
brain wire --provider gitlab --gitlab-token glpat-xxx
# or
export SECOND_BRAIN_GITLAB_TOKEN=glpat-xxx
brain wire --provider gitlab
```

### Webhook Events

The following events are registered when wiring:

| Event                     | What it captures                        |
|---------------------------|-----------------------------------------|
| `merge_requests_events`   | MR open, update, merge, close           |
| `note_events`             | Comments on MRs                         |
| `pipeline_events`         | CI/CD pipeline status changes           |

### Delivery Verification

GitLab uses **token-based** verification:

- Header: `X-Gitlab-Token`
- The token is generated during `brain wire` and stored in the system keychain
  as `gitlab.webhook-token:<projectId>`.
- Verified server-side via `timingSafeEqual` (constant-time comparison).

### Keychain Entries

| Key                                  | Value              |
|--------------------------------------|--------------------|
| `gitlab.webhook-token:<projectId>`   | Webhook secret     |
| `gitlab.pat:<host>`                  | Personal Access Token |

---

## GitHub

### Token Types

**Classic PAT** — requires these scopes:

| Scope              | Purpose                   |
|--------------------|---------------------------|
| `repo`             | Access to repository data |
| `admin:repo_hook`  | Webhook management        |

**Fine-grained PAT** — requires these repository permissions:

| Permission           | Access | Purpose              |
|----------------------|--------|----------------------|
| Repository webhooks  | Write  | Create/delete hooks  |
| Pull requests        | Read   | Read PR data         |

Set via flag or environment variable:

```bash
brain wire --provider github --github-token ghp_xxx
# or
export SECOND_BRAIN_GITHUB_TOKEN=ghp_xxx
# or (fallback)
export GITHUB_TOKEN=ghp_xxx
brain wire --provider github
```

### Webhook Events

The following events are registered when wiring:

| Event                            | What it captures                 |
|----------------------------------|----------------------------------|
| `pull_request`                   | PR open, update, merge, close    |
| `pull_request_review`            | Review submitted (approve, etc.) |
| `pull_request_review_comment`    | Inline review comments           |
| `check_suite`                    | CI check results                 |

### Delivery Verification

GitHub uses **HMAC-SHA256** verification:

- Header: `X-Hub-Signature-256`
- Format: `sha256=<hex-digest>`
- The HMAC secret is generated during `brain wire` and stored in the keychain
  as `github.webhook-secret:<owner>/<repo>`.
- Verified server-side via `timingSafeEqual` on the HMAC digest.

### GitHub Enterprise

For GitHub Enterprise instances, set the base URL:

```bash
brain wire --provider github --github-base-url https://github.example.com/api/v3
```

### Email Resolution

When a user's email is not publicly available, GitHub falls back to the noreply
address:

```
${id}+${username}@users.noreply.github.com
```

### Keychain Entries

| Key                                       | Value              |
|-------------------------------------------|--------------------|
| `github.webhook-secret:<owner>/<repo>`    | HMAC secret        |
| `github.pat:github.com`                   | Personal Access Token |

---

## Custom Provider

For git forges not natively supported (Gitea, Forgejo, Gogs, etc.). Custom
providers use a JSON mapping file that tells Second Brain how to extract
observation data from arbitrary webhook payloads.

### Overview

- **Mapping directory:** `~/.second-brain/providers/<name>.json`
- **Webhook auto-registration:** not supported — you must create the webhook
  manually on your forge instance.
- **Webhook auto-removal:** not supported — you must remove the webhook
  manually.

### Generating a Template

```bash
brain provider template --name gitea
```

This creates `~/.second-brain/providers/gitea.json` with a skeleton mapping
file ready for customization.

### Mapping File Format

The mapping file conforms to the `CustomProviderMapping` JSON schema:

```jsonc
{
  // Human-readable name (e.g., "gitea", "forgejo")
  "name": "gitea",

  // Schema version (always 1)
  "version": 1,

  // How to verify incoming webhook deliveries
  "verification": {
    "kind": "token",          // "token" or "hmac"
    "header": "x-gitea-token" // header name to read
  },

  // Header containing the event type discriminator
  "eventTypeHeader": "x-gitea-event",

  // Optional: header for delivery dedup (falls back to UUID generation)
  "deliveryIdHeader": "x-gitea-delivery",

  // Event type → field path mappings
  "mappings": {
    "pull_request": { ... },
    "review": { ... },
    "comment": { ... }
  },

  // Optional: map forge action strings to canonical actions
  "actionMap": {
    "opened": "open",
    "synchronized": "update",
    "closed": "close",
    "merged": "merge"
  },

  // Optional: noreply email template ({login} is replaced)
  "noreplyEmailTemplate": "{login}@noreply.gitea.example.com"
}
```

### Verification Config

**Token-based** (e.g., Gitea, Forgejo):

```json
{
  "kind": "token",
  "header": "x-gitea-token"
}
```

The token value is checked via constant-time comparison against the stored
secret.

**HMAC-based** (e.g., Gogs):

```json
{
  "kind": "hmac",
  "header": "x-gogs-signature",
  "algorithm": "sha256",
  "prefix": ""
}
```

Supported algorithms: `sha256`, `sha1`. The `prefix` is stripped from the
header value before comparison (e.g., `"sha256="` for GitHub-style signatures).

### Field Path Notation

Field paths use dot-notation to extract values from JSON webhook payloads.
Leading `$.` is optional convention.

| Path                              | Resolves to                                  |
|-----------------------------------|----------------------------------------------|
| `$.action`                        | `payload.action`                             |
| `$.pull_request.number`           | `payload.pull_request.number`                |
| `$.pull_request.user.login`       | `payload.pull_request.user.login`            |
| `$.pull_request.head.ref`         | `payload.pull_request.head.ref` (source branch) |
| `$.repository.full_name`          | `payload.repository.full_name`               |

### Pull Request Mapping

```json
{
  "pull_request": {
    "action": "$.action",
    "number": "$.pull_request.number",
    "title": "$.pull_request.title",
    "body": "$.pull_request.body",
    "state": "$.pull_request.state",
    "sourceBranch": "$.pull_request.head.ref",
    "targetBranch": "$.pull_request.base.ref",
    "authorLogin": "$.pull_request.user.login",
    "authorEmail": "$.pull_request.user.email",
    "merged": "$.pull_request.merged",
    "mergedAt": "$.pull_request.merged_at",
    "webUrl": "$.pull_request.html_url",
    "draft": "$.pull_request.draft"
  }
}
```

**Required fields:** `action`, `number`, `title`, `sourceBranch`,
`targetBranch`, `authorLogin`.

**Optional fields:** `body`, `state`, `authorEmail`, `merged`, `mergedAt`,
`webUrl`, `draft`.

### Review Mapping

```json
{
  "review": {
    "state": "$.review.state",
    "prNumber": "$.pull_request.number",
    "authorLogin": "$.review.user.login",
    "createdAt": "$.review.submitted_at"
  }
}
```

### Comment Mapping

```json
{
  "comment": {
    "body": "$.comment.body",
    "commentId": "$.comment.id",
    "prNumber": "$.pull_request.number",
    "authorLogin": "$.comment.user.login",
    "createdAt": "$.comment.created_at"
  }
}
```

### Action Map

Maps forge-specific action strings to canonical Second Brain actions:

| Canonical Action     | Meaning                          |
|----------------------|----------------------------------|
| `open`               | PR/MR opened                     |
| `update`             | PR/MR updated (new commits, etc) |
| `merge`              | PR/MR merged                     |
| `close`              | PR/MR closed without merge       |
| `approve`            | Review approved                  |
| `request_changes`    | Review requested changes         |
| `comment`            | Comment posted                   |

### Example: Gitea Configuration

```json
{
  "name": "gitea",
  "version": 1,
  "verification": {
    "kind": "token",
    "header": "x-gitea-token"
  },
  "eventTypeHeader": "x-gitea-event",
  "deliveryIdHeader": "x-gitea-delivery",
  "mappings": {
    "pull_request": {
      "action": "$.action",
      "number": "$.pull_request.number",
      "title": "$.pull_request.title",
      "body": "$.pull_request.body",
      "state": "$.pull_request.state",
      "sourceBranch": "$.pull_request.head.ref",
      "targetBranch": "$.pull_request.base.ref",
      "authorLogin": "$.pull_request.user.login",
      "authorEmail": "$.pull_request.user.email",
      "merged": "$.pull_request.merged",
      "mergedAt": "$.pull_request.merged_at",
      "webUrl": "$.pull_request.html_url",
      "draft": "$.pull_request.draft"
    },
    "review": {
      "state": "$.review.state",
      "prNumber": "$.pull_request.number",
      "authorLogin": "$.review.user.login",
      "createdAt": "$.review.submitted_at"
    },
    "comment": {
      "body": "$.comment.body",
      "commentId": "$.comment.id",
      "prNumber": "$.pull_request.number",
      "authorLogin": "$.comment.user.login",
      "createdAt": "$.comment.created_at"
    }
  },
  "actionMap": {
    "opened": "open",
    "synchronized": "update",
    "closed": "close",
    "merged": "merge",
    "approved": "approve",
    "rejected": "request_changes"
  },
  "noreplyEmailTemplate": "{login}@noreply.gitea.example.com"
}
```

### Example: Forgejo Configuration

Forgejo is API-compatible with Gitea. The same mapping file works:

```bash
cp ~/.second-brain/providers/gitea.json ~/.second-brain/providers/forgejo.json
```

Edit the `name` field to `"forgejo"` and update the `noreplyEmailTemplate` if
your Forgejo instance uses a different domain.
