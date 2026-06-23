# Second Brain — API Reference

> **Version 0.1.0** · Developer knowledge graph system
>
> Three interfaces to the same graph: REST API for integrations, MCP tools for AI assistants, CLI for humans.

---

## Table of Contents

- [Shared Types](#shared-types)
- [REST API](#rest-api)
  - [Health](#health)
  - [Entities](#entities)
  - [Relations](#relations)
  - [Search](#search)
  - [Temporal](#temporal)
  - [Sync](#sync)
  - [Observe](#observe)
  - [Query](#query)
- [MCP Tools](#mcp-tools)
  - [Read Tools](#read-tools)
  - [Write Tools](#write-tools)
  - [Pipeline Tools](#pipeline-tools)
- [CLI Commands](#cli-commands)
  - [Initialization & Setup](#initialization--setup)
  - [Entity Management](#entity-management)
  - [Status & Statistics](#status--statistics)
  - [Knowledge Entry](#knowledge-entry)
  - [Indexing Pipeline](#indexing-pipeline)
  - [Vector Embeddings](#vector-embeddings)
  - [Context Generation](#context-generation)
  - [Export & Import](#export--import)
  - [Monitoring & Live Capture](#monitoring--live-capture)
  - [Hook Management](#hook-management)
  - [Repository Wiring](#repository-wiring)
  - [Branch Status Management](#branch-status-management)
  - [Ownership Analysis](#ownership-analysis)
  - [Team Synchronization](#team-synchronization)
  - [Personal Data Management](#personal-data-management)

---

## Shared Types

Core types returned by all three interfaces. IDs are ULIDs; timestamps are ISO 8601 strings.

### Entity

```typescript
interface Entity {
  id: string;                          // ULID
  type: EntityType;
  name: string;
  namespace: string;                   // "personal" or project ID
  observations: string[];              // atomic facts
  properties: Record<string, unknown>;
  confidence: number;                  // 0.0–1.0
  eventTime: string;                   // when the fact happened
  ingestTime: string;                  // when it was recorded
  lastAccessedAt: string;
  accessCount: number;
  source: EntitySource;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

type EntityType =
  | 'concept' | 'decision' | 'pattern' | 'person' | 'file'
  | 'symbol' | 'event' | 'tool' | 'fact' | 'conversation'
  | 'reference' | 'pull_request' | 'merge_request' | 'branch' | 'review';

interface EntitySource {
  type: 'git' | 'ast' | 'conversation' | 'github' | 'gitlab'
      | 'manual' | 'doc' | 'inferred' | 'personality' | 'watch'
      | 'git-hook' | 'hook';
  ref?: string;
  actor?: string;
}
```

### Relation

```typescript
interface Relation {
  id: string;
  type: RelationType;
  sourceId: string;
  targetId: string;
  namespace: string;
  properties: Record<string, unknown>;
  confidence: number;
  weight: number;                      // 0.0–1.0
  bidirectional: boolean;
  source: EntitySource;
  eventTime: string;
  ingestTime: string;
  createdAt: string;
  updatedAt: string;
}

type RelationType =
  | 'relates_to' | 'depends_on' | 'implements' | 'supersedes'
  | 'contradicts' | 'derived_from' | 'authored_by' | 'decided_in'
  | 'uses' | 'tests' | 'contains' | 'co_changes_with'
  | 'preceded_by' | 'blocks' | 'reviewed_by'
  | 'merged_in_mr' | 'merged_in_pr' | 'touches_file'
  | 'owns' | 'parallel_with';
```

### Other Types

```typescript
interface SearchResult {
  entity: Entity;
  score: number;
  matchChannel: 'fulltext' | 'vector' | 'graph';
  highlights?: string[];
}

interface GraphStats {
  totalEntities: number;
  totalRelations: number;
  entitiesByType: Record<string, number>;
  relationsByType: Record<string, number>;
  namespaces: string[];
}

interface TimelineEntry {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  changeType: 'created' | 'updated';
  timestamp: string;
  confidence: number;
  namespace: string;
}

interface Contradiction {
  relation: Relation;
  entityA: Entity;
  entityB: Entity;
}

interface SyncStatus {
  namespace: string;
  state: 'disconnected' | 'connecting' | 'connected' | 'syncing';
  connectedPeers: number;
  lastSyncedAt: string | null;
  pendingChanges: number;
  error: string | null;
}

interface PeerInfo {
  clientId: number;
  name: string;
  color: string;
  connectedAt: string;
}
```

---

## REST API

**Base URL:** `http://localhost:7430` (override with `BRAIN_API_PORT`)

All endpoints return JSON. CORS is restricted to `localhost` origins. Errors follow the shape `{ error: string }`.

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |

**Response** `200`

```json
{ "status": "ok", "version": "0.1.0" }
```

---

### Entities

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/entities` | List entities |
| `GET` | `/api/entities/:id` | Get entity with relations |
| `POST` | `/api/entities` | Create entity |
| `PATCH` | `/api/entities/:id` | Update entity |
| `DELETE` | `/api/entities/:id` | Delete entity |
| `POST` | `/api/entities/:id/observations` | Add observation |
| `DELETE` | `/api/entities/:id/observations` | Remove observation |
| `GET` | `/api/entities/:id/neighbors` | Graph neighbors |

#### `GET /api/entities`

List entities with optional filters.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `namespace` | string | — | Filter by namespace |
| `type` | EntityType | — | Filter by entity type |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Response** `200` — `Entity[]`

```json
[
  {
    "id": "01J5X...",
    "type": "concept",
    "name": "Event Sourcing",
    "namespace": "personal",
    "observations": ["Append-only log of state changes"],
    "confidence": 0.95,
    "tags": ["architecture"],
    ...
  }
]
```

#### `GET /api/entities/:id`

Returns the entity plus all inbound and outbound relations.

**Response** `200`

```json
{
  "entity": { ... },
  "outbound": [ { "id": "...", "type": "depends_on", ... } ],
  "inbound":  [ { "id": "...", "type": "authored_by", ... } ]
}
```

**Response** `404` — `{ "error": "Entity not found" }`

#### `POST /api/entities`

Create a new entity.

| Body Field | Type | Required | Default | Description |
|------------|------|----------|---------|-------------|
| `type` | EntityType | ✓ | — | Entity type |
| `name` | string | ✓ | — | Human-readable name |
| `observations` | string[] | — | `[]` | Atomic facts |
| `tags` | string[] | — | `[]` | Categorization tags |
| `namespace` | string | — | `"personal"` | Namespace |
| `properties` | object | — | `{}` | Structured metadata |
| `confidence` | number | — | `1.0` | Confidence (0–1) |

**Request**

```json
{
  "type": "decision",
  "name": "Use SQLite for storage",
  "observations": ["Chose SQLite over Postgres for single-user simplicity"],
  "tags": ["database", "architecture"],
  "namespace": "personal"
}
```

**Response** `201` — `Entity`

#### `PATCH /api/entities/:id`

Partial update. Only provided fields are changed.

| Body Field | Type | Required | Description |
|------------|------|----------|-------------|
| `name` | string | — | New name |
| `observations` | string[] | — | Replace all observations |
| `tags` | string[] | — | Replace all tags |
| `properties` | object | — | Replace properties |
| `confidence` | number | — | New confidence (0–1) |

**Response** `200` — `Entity`

#### `DELETE /api/entities/:id`

Deletes the entity and all attached relations.

**Response** `204` — No Content

#### `POST /api/entities/:id/observations`

Append a single observation to an entity.

| Body Field | Type | Required | Description |
|------------|------|----------|-------------|
| `observation` | string | ✓ | Atomic fact to append |

**Response** `200` — `Entity` (updated)

#### `DELETE /api/entities/:id/observations`

Remove a specific observation from an entity.

| Body Field | Type | Required | Description |
|------------|------|----------|-------------|
| `observation` | string | ✓ | Exact observation text to remove |

**Response** `200` — `Entity` (updated)

#### `GET /api/entities/:id/neighbors`

Traverse the graph from a starting entity.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `depth` | integer | `1` | Traversal depth (1–5) |
| `relationTypes` | string | — | Comma-separated relation types |

**Response** `200`

```json
{
  "entities": [ ... ],
  "relations": [ ... ]
}
```

---

### Relations

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/relations` | Create relation |
| `GET` | `/api/relations/:id` | Get relation |
| `DELETE` | `/api/relations/:id` | Delete relation |

#### `POST /api/relations`

| Body Field | Type | Required | Default | Description |
|------------|------|----------|---------|-------------|
| `type` | RelationType | ✓ | — | Relation type |
| `sourceId` | string | ✓ | — | Source entity ULID |
| `targetId` | string | ✓ | — | Target entity ULID |
| `namespace` | string | — | `"personal"` | Namespace |
| `properties` | object | — | `{}` | Metadata |
| `confidence` | number | — | `1.0` | Confidence (0–1) |
| `weight` | number | — | `1.0` | Edge weight (0–1) |
| `bidirectional` | boolean | — | `false` | Bidirectional edge |

**Request**

```json
{
  "type": "depends_on",
  "sourceId": "01J5X...",
  "targetId": "01J5Y..."
}
```

**Response** `201` — `Relation`

#### `GET /api/relations/:id`

**Response** `200` — `Relation`

#### `DELETE /api/relations/:id`

**Response** `204` — No Content

---

### Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/search` | Full-text search |
| `GET` | `/api/stats` | Graph statistics |

#### `GET /api/search`

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `q` | string | ✓ (required) | Search query |
| `namespace` | string | — | Filter by namespace |
| `types` | string | — | Comma-separated EntityType list |
| `limit` | integer | `20` | Max results (1–100) |
| `offset` | integer | `0` | Pagination offset |
| `minConfidence` | number | — | Minimum confidence threshold |

**Response** `200` — `SearchResult[]`

```json
[
  {
    "entity": { "id": "01J5X...", "name": "Event Sourcing", ... },
    "score": 0.87,
    "matchChannel": "fulltext",
    "highlights": ["...append-only <b>log</b>..."]
  }
]
```

#### `GET /api/stats`

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `namespace` | string | — | Filter stats to a namespace |

**Response** `200` — `GraphStats`

```json
{
  "totalEntities": 342,
  "totalRelations": 891,
  "entitiesByType": { "concept": 120, "decision": 45, ... },
  "relationsByType": { "depends_on": 200, "relates_to": 150, ... },
  "namespaces": ["personal", "proj-alpha"]
}
```

---

### Temporal

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/timeline` | Changes over a time range |
| `GET` | `/api/contradictions` | Unresolved contradictions |
| `POST` | `/api/contradictions/:id/resolve` | Resolve a contradiction |
| `DELETE` | `/api/contradictions/:id` | Dismiss a contradiction |
| `GET` | `/api/stale` | Entities with decayed confidence |
| `GET` | `/api/decisions` | List decision entities |
| `GET` | `/api/temporal/entities` | Bi-temporal entity query |

#### `GET /api/timeline`

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `from` | string | ✓ (required) | ISO 8601 start |
| `to` | string | ✓ (required) | ISO 8601 end |
| `namespace` | string | — | Filter by namespace |
| `types` | string | — | Comma-separated EntityType list |
| `limit` | integer | `100` | Max results (1–500) |

**Response** `200` — `TimelineEntry[]`

```json
[
  {
    "entityId": "01J5X...",
    "entityName": "Use SQLite",
    "entityType": "decision",
    "changeType": "created",
    "timestamp": "2025-01-15T10:30:00Z",
    "confidence": 1.0,
    "namespace": "personal"
  }
]
```

#### `GET /api/contradictions`

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `namespace` | string | — | Filter by namespace |

**Response** `200` — `Contradiction[]`

```json
[
  {
    "relation": { "id": "01J6A...", "type": "contradicts", ... },
    "entityA": { "id": "01J5X...", "name": "Use REST", ... },
    "entityB": { "id": "01J5Y...", "name": "Use GraphQL", ... }
  }
]
```

#### `POST /api/contradictions/:id/resolve`

Resolve by picking a winner. The loser's confidence is set to 0 and a `supersedes` relation is created.

| Body Field | Type | Required | Description |
|------------|------|----------|-------------|
| `winnerId` | string | ✓ | Entity ULID that wins |

**Response** `200`

```json
{ "resolved": true, "winnerId": "01J5X...", "loserId": "01J5Y..." }
```

#### `DELETE /api/contradictions/:id`

Dismiss without resolution — deletes the `contradicts` relation, both entities unchanged.

**Response** `204` — No Content

#### `GET /api/stale`

Returns entities whose effective confidence has decayed below a threshold.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `threshold` | number | `0.5` | Confidence threshold (0–1) |
| `namespace` | string | — | Filter by namespace |
| `types` | string | — | Comma-separated EntityType list |

**Response** `200` — `Entity[]`

#### `GET /api/decisions`

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `namespace` | string | — | Filter by namespace |
| `limit` | integer | `20` | Max results |
| `sort` | string | — | Sort field |

**Response** `200` — `Entity[]` (type = `decision`)

#### `GET /api/temporal/entities`

Bi-temporal query: view entities as they existed at a specific point in time.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `asOfEventTime` | string | — | ISO 8601 event-time cutoff |
| `asOfIngestTime` | string | — | ISO 8601 ingest-time cutoff |
| `namespace` | string | — | Filter by namespace |

**Response** `200` — `Entity[]`

---

### Sync

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sync/status` | All sync statuses |
| `GET` | `/api/sync/status/:namespace` | Status for one namespace |
| `POST` | `/api/sync/join` | Join a sync room |
| `POST` | `/api/sync/leave` | Leave a sync room |
| `GET` | `/api/sync/peers/:namespace` | List connected peers |

#### `POST /api/sync/join`

| Body Field | Type | Required | Description |
|------------|------|----------|-------------|
| `namespace` | string | ✓ | Project namespace to sync |
| `relayUrl` | string | ✓ | WebSocket relay URL (`ws://` or `wss://`) |
| `token` | string | ✓ | Auth token for relay |

**Response** `200` — `SyncStatus`

#### `POST /api/sync/leave`

| Body Field | Type | Required | Description |
|------------|------|----------|-------------|
| `namespace` | string | ✓ | Namespace to stop syncing |

**Response** `200`

```json
{ "left": "my-team-project" }
```

#### `GET /api/sync/peers/:namespace`

**Response** `200` — `PeerInfo[]`

```json
[
  { "clientId": 1, "name": "alice", "color": "#e06c75", "connectedAt": "2025-01-15T10:00:00Z" }
]
```

---

### Observe

Webhook/hook endpoints for external event ingestion.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/observe/session-start` | AI session started |
| `POST` | `/api/observe/prompt-submit` | Prompt submitted |
| `POST` | `/api/observe/mr-event` | Merge/pull request webhook |
| `POST` | `/api/observe/file-change` | File watcher events |

#### `POST /api/observe/session-start`

Called when an AI coding session begins. Returns context for injection.

**Response** `200`

```json
{
  "conversationId": "01J5X...",
  "namespace": "personal",
  "contextBlock": "<!-- Prior context -->\n..."
}
```

#### `POST /api/observe/prompt-submit`

Called on each prompt submission within a session.

**Response** `200`

```json
{ "conversationId": "01J5X..." }
```

#### `POST /api/observe/mr-event`

Receives forge webhooks (GitLab/GitHub) for merge/pull request lifecycle events.
Webhook verification secrets are loaded from server env vars:
`SECOND_BRAIN_WEBHOOK_SECRET_HEX__<provider>__<hexProjectId>` for token
verification and `SECOND_BRAIN_WEBHOOK_HMAC_HEX__<provider>__<hexProjectId>`
for HMAC verification. `brain wire --provider ...` prints the exact `export`
line to add to the server environment.

#### `POST /api/observe/file-change`

Receives file-change events from the `brain watch` daemon.

---

### Query

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/query/ownership` | File ownership scores |

#### `GET /api/query/ownership`

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `path` | string | ✓ (required) | Repository-relative file path |
| `limit` | integer | `3` | Max owners (1–50) |

**Response** `200`

```json
[
  {
    "actor": "alice",
    "score": 0.72,
    "signals": {
      "commits": 45,
      "blameLines": 320,
      "reviews": 12,
      "testAuthorship": 5,
      "codeowner": true
    }
  }
]
```

---

## MCP Tools

Registered via the MCP protocol (stdio or streamable HTTP). All inputs validated with Zod. All outputs are text content blocks.

### Read Tools

Read-only operations. Annotated with `readOnlyHint: true`.

#### `search_brain`

Search the knowledge graph using full-text search.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | ✓ | — | Search query text |
| `namespace` | string | — | — | Filter by namespace |
| `types` | EntityType[] | — | — | Filter by entity types |
| `limit` | integer | — | `20` | Max results (max 100) |
| `minConfidence` | number | — | — | Minimum confidence (0–1) |

**Output:** Formatted text listing entities with type, name, score, confidence, observations, tags, and namespace.

---

#### `get_entity`

Get a specific entity by ID with all its observations, tags, properties, and connected relations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Entity ID (ULID) |

**Output:** Markdown with full entity metadata, observations, tags, properties, inbound/outbound relations.

---

#### `get_neighbors`

Get entities connected to a given entity via relations.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `entityId` | string | ✓ | — | Starting entity ID |
| `depth` | integer | — | `1` | Traversal depth (max 5) |
| `relationTypes` | RelationType[] | — | — | Filter by relation types |

**Output:** Neighbor list with type, name, ID, first observation; relations table.

---

#### `traverse_graph`

Find all paths between two entities up to a maximum depth.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `fromId` | string | ✓ | — | Starting entity ID |
| `toId` | string | ✓ | — | Target entity ID |
| `maxDepth` | integer | — | `5` | Max path length (max 10) |

**Output:** Numbered paths showing entity names and relation types at each hop.

---

#### `search_decisions`

Find decision entities by topic.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | ✓ | — | Search query |
| `namespace` | string | — | — | Filter by namespace |
| `limit` | integer | — | `20` | Max results (max 100) |

**Output:** Decision results with name, confidence, observations, ID, namespace, createdAt.

---

#### `search_patterns`

Find recurring pattern entities by domain or technology.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | ✓ | — | Search query |
| `namespace` | string | — | — | Filter by namespace |
| `limit` | integer | — | `20` | Max results (max 100) |

**Output:** Pattern results with name, confidence, observations, ID, namespace.

---

#### `get_graph_stats`

Get knowledge graph statistics: entity/relation counts, breakdown by type, namespaces.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | — | Filter stats by namespace |

**Output:** Total entities, relations, namespaces, and breakdowns by entity type and relation type.

---

#### `get_contradictions`

List unresolved contradictions — entity pairs linked by `contradicts` where neither is superseded.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | — | Filter by namespace |

**Output:** Markdown listing each contradiction with relation ID, both entities' metadata.

---

#### `get_timeline`

View knowledge changes over a time range.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `from` | string | ✓ | — | ISO 8601 start |
| `to` | string | ✓ | — | ISO 8601 end |
| `namespace` | string | — | — | Filter by namespace |
| `types` | EntityType[] | — | — | Filter by entity types |
| `limit` | integer | — | `100` | Max results (max 500) |

**Output:** Grouped by date. Each entry shows change type (`+`/`~`), entity type, name, confidence.

---

#### `recall_session_context`

Surface memory relevant to the current session. Merges session-scoped and cross-session hits.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sessionId` | string | — | — | Active session ID |
| `query` | string | — | — | Free-text query (or most-recent if absent) |
| `namespaces` | string[] | — | `["personal"]` | Extra namespaces to include |
| `limit` | integer | — | `15` | Max entities (max 50) |
| `includeParallelWork` | boolean | — | `false` | Prepend parallel-work-alert |

**Output:** Markdown context block with optional `<parallel-work-alert>` XML tag and entity list.

---

#### `find_parallel_work`

Surface entities touched by ≥2 actors on WIP branches. Detects collisions before merge conflicts.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `branch` | string | — | — | Limit to this branch |
| `namespace` | string | — | — | Filter namespace |
| `pathLike` | string | — | — | Substring match on entity name |
| `limit` | integer | — | `50` | Max rows (max 200) |

**Output:** Entity type, name, namespace, actors list, branches list.

---

#### `get_ownership`

Compute file ownership scores (blame, commits, reviews, tests, CODEOWNERS).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | ✓ | — | Repository-relative file path |
| `limit` | integer | — | `3` | Max owners (max 50) |

**Output:** Ranked owners with score percentage and signal breakdown.

---

#### `timeline_around`

Return entities whose `eventTime` falls within a window around an anchor entity.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `entityId` | string | ✓ | — | Anchor entity ID |
| `windowMinutes` | integer | — | `60` | Half-width in minutes (max 20160) |
| `namespace` | string | — | — | Filter namespace |

**Output:** Activity list with timestamps, change type, entity type, name, ID.

---

#### `get_observations_by_ids`

Fetch full entity records for a set of IDs. Bumps `accessCount` to defer decay.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | ✓ | Entity IDs (1–100) |

**Output:** Entity details with type, name, ID, namespace, confidence, observations preview.

---

#### `get_stale`

Find entities with decayed confidence below a threshold.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `threshold` | number | — | `0.5` | Confidence cutoff (0–1) |
| `namespace` | string | — | — | Filter by namespace |
| `types` | EntityType[] | — | — | Filter by entity types |
| `limit` | integer | — | `50` | Max results (max 100) |

**Output:** Stale entities with type, name, base confidence, effective confidence, last accessed, namespace.

---

### Write Tools

Data modification operations. Annotated with `readOnlyHint: false`.

#### `add_entity`

Create a new entity in the knowledge graph.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | EntityType | ✓ | — | Entity type |
| `name` | string | ✓ | — | Human-readable name |
| `observations` | string[] | — | `[]` | Atomic facts |
| `tags` | string[] | — | `[]` | Tags |
| `namespace` | string | — | `"personal"` | Namespace |
| `properties` | object | — | `{}` | Structured properties |
| `confidence` | number | — | `1.0` | Confidence (0–1) |

**Output:** Confirmation with entity type, name, and generated ULID.

---

#### `add_relation`

Create a relationship between two entities.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | RelationType | ✓ | — | Relation type |
| `sourceId` | string | ✓ | — | Source entity ID |
| `targetId` | string | ✓ | — | Target entity ID |
| `namespace` | string | — | `"personal"` | Namespace |
| `weight` | number | — | `1.0` | Edge weight (0–1) |
| `confidence` | number | — | `1.0` | Confidence (0–1) |
| `bidirectional` | boolean | — | `false` | Bidirectional edge |
| `properties` | object | — | `{}` | Metadata |

**Output:** Confirmation with source → relation type → target and generated relation ID.

---

#### `add_observation`

Append an atomic fact to an existing entity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entityId` | string | ✓ | Entity ID |
| `observation` | string | ✓ | The observation text |

**Output:** Confirmation with entity name and new observation count.

---

#### `record_decision`

Record a decision with context and optional links to related entities.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `decision` | string | ✓ | — | The decision made |
| `context` | string | — | — | Reasoning / context |
| `relatedEntityIds` | string[] | — | `[]` | IDs to link via `decided_in` |
| `namespace` | string | — | `"personal"` | Namespace |
| `tags` | string[] | — | `[]` | Tags |

**Output:** Confirmation with decision name, ID, and linked entities.

---

#### `record_pattern`

Record a recurring pattern with examples.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | ✓ | — | Pattern name |
| `observations` | string[] | — | `[]` | Observations |
| `exampleEntityIds` | string[] | — | `[]` | Example entity IDs |
| `namespace` | string | — | `"personal"` | Namespace |
| `tags` | string[] | — | `[]` | Tags |

**Output:** Confirmation with pattern name, ID, and linked examples.

---

#### `record_fact`

Record a discrete fact with source tracking.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | ✓ | — | Short fact title |
| `observations` | string[] | ✓ | — | Fact details |
| `sourceRef` | string | — | — | Source reference (URL, commit) |
| `namespace` | string | — | `"personal"` | Namespace |
| `tags` | string[] | — | `[]` | Tags |
| `confidence` | number | — | `1.0` | Confidence (0–1) |

**Output:** Confirmation with fact name and generated ID.

---

#### `update_entity`

Update an existing entity. Only provided fields are changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Entity ID |
| `name` | string | — | New name |
| `observations` | string[] | — | Replace all observations |
| `tags` | string[] | — | Replace all tags |
| `confidence` | number | — | New confidence (0–1) |
| `properties` | object | — | Replace properties |

**Output:** Confirmation with entity name and ID.

---

#### `merge_entities`

Merge two duplicates. Keeps the primary; merges observations, tags, re-points relations; deletes secondary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `primaryId` | string | ✓ | Entity to keep |
| `secondaryId` | string | ✓ | Entity to merge and delete |

**Output:** Summary with merged observations count, tags count, re-pointed relations count.

---

#### `invalidate`

Mark an entity as superseded. Sets confidence to 0 and optionally creates a `supersedes` relation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entityId` | string | ✓ | Entity to invalidate |
| `replacementId` | string | — | Entity that supersedes |
| `reason` | string | — | Reason for invalidation |

**Output:** Confirmation with invalidated entity name and optional replacement.

---

#### `resolve_contradiction`

Pick a winner for a contradiction. Creates `supersedes` from winner to loser, sets loser confidence to 0, deletes the `contradicts` relation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `relationId` | string | ✓ | ID of the `contradicts` relation |
| `winnerId` | string | ✓ | Entity that should win |

**Output:** Confirmation with winner superseding loser.

---

#### `dismiss_contradiction`

Dismiss a contradiction without resolving it. Deletes the `contradicts` relation; both entities unchanged.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `relationId` | string | ✓ | Contradicts relation ID |

**Output:** Confirmation with relation ID.

---

#### `flip_branch_status`

Bulk-update `branchContext.status` on all entities and relations carrying a given branch. Admin escape hatch. Annotated with `destructiveHint: true`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch` | string | ✓ | Branch name (exact match) |
| `status` | `wip` \| `merged` \| `abandoned` | ✓ | New status |
| `mrIid` | integer | — | MR/PR iid |
| `mergedAt` | string | — | ISO timestamp (when `merged`) |

**Output:** Confirmation with branch, new status, updated entity/relation counts.

---

### Pipeline Tools

Data transformation and ingestion operations.

#### `reindex`

Rebuild the FTS5 full-text search index.

**Parameters:** None

**Output:** Confirmation that the index was rebuilt.

---

#### `export_graph`

Export the knowledge graph in JSON, JSON-LD, or DOT format.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `format` | `json` \| `json-ld` \| `dot` | ✓ | — | Output format |
| `namespace` | string | — | — | Filter to a namespace |
| `types` | EntityType[] | — | — | Filter entity types |
| `includeRelations` | boolean | — | `true` | Include relations |

**Output:** Serialized graph content in the requested format.

---

#### `import_graph`

Import entities + relations from a JSON or JSON-LD payload.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | ✓ | — | Serialized graph payload |
| `format` | `json` \| `json-ld` | ✓ | — | Source format |
| `strategy` | `replace` \| `merge` \| `upsert` | — | `upsert` | Conflict handling |
| `namespace` | string | — | — | Override namespace |

**Output:** Summary with imported entity/relation counts and any conflicts.

---

#### `rebuild_embeddings`

Generate or regenerate vector embeddings. Requires `BRAIN_LLM_PROVIDER` and `BRAIN_EMBEDDING_MODEL` env vars.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `namespace` | string | — | — | Limit to a namespace |
| `batchSize` | integer | — | `64` | Per-request batch (1–500) |
| `dimensions` | integer | — | — | Vector dimensions (e.g. 768, 1536) |

**Output:** Summary with embedded/skipped/error counts, duration, and model name.

---

#### `query_graph`

Natural-language query. Uses LLM for interpretation + multi-channel search (FTS + vector) when configured; falls back to plain FTS otherwise.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | ✓ | — | Natural language question |
| `namespace` | string | — | — | Filter by namespace |
| `limit` | integer | — | `10` | Max results (max 50) |

**Output:** Top results with entity type, name, relevance score, match channel, and ID.

---

## CLI Commands

The `brain` CLI. Install from `tools/cli`; all commands accept `--help`.

```
brain <command> [options]
```

### Initialization & Setup

#### `brain init`

Initialize a new brain (interactive wizard).

```bash
brain init [options]
```

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Default namespace |
| `--db <path>` | Custom database path |
| `-y, --yes` | Non-interactive: accept defaults |
| `--wire-claude` | Patch `~/.claude.json` with MCP server entry |

#### `brain reset`

Remove `~/.second-brain` and optionally restore `~/.claude.json`.

```bash
brain reset [options]
```

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |
| `--wire-claude` | Also restore `~/.claude.json` from backup |
| `--dir <path>` | Override brain directory |

---

### Entity Management

#### `brain add`

```bash
brain add <type> <name> [options]
```

| Argument | Description |
|----------|-------------|
| `type` | Entity type (concept, decision, pattern, etc.) |
| `name` | Entity name |

| Flag | Description |
|------|-------------|
| `-o, --obs <observations...>` | Observations (atomic facts) |
| `-t, --tags <tags...>` | Tags |
| `-n, --namespace <ns>` | Namespace (default: `personal`) |

**Example:**

```bash
brain add decision "Use SQLite" -o "Simpler than Postgres for single-user" -t database
```

#### `brain search`

```bash
brain search <query> [options]
```

| Flag | Description |
|------|-------------|
| `-t, --type <types...>` | Filter by entity type |
| `-n, --namespace <ns>` | Filter by namespace |
| `-l, --limit <n>` | Max results (default: 20) |

#### `brain query`

Natural-language query (LLM-backed when configured).

```bash
brain query <question...> [options]
```

| Flag | Description |
|------|-------------|
| `-n, --namespace <ns>` | Filter by namespace |
| `--limit <n>` | Max results (default: 10) |
| `--vector` | Include vector channel (requires embeddings) |

---

### Status & Statistics

#### `brain status`

```bash
brain status [-n <namespace>]
```

Shows database path, total entities/relations, namespace list, and type breakdowns.

---

### Knowledge Entry

#### `brain decide`

```bash
brain decide <decision> [options]
```

| Flag | Description |
|------|-------------|
| `-c, --context <text>` | Decision context / reasoning |
| `-n, --namespace <ns>` | Namespace (default: `personal`) |

---

### Indexing Pipeline

#### `brain index`

Top-level index command with subcommands for each source.

```bash
brain index [options]          # Run all indexers
brain index git [options]      # Git history
brain index ast [options]      # Code AST
brain index docs [options]     # Markdown documentation
brain index conversation [options]  # AI conversation logs
brain index github [options]   # GitHub PRs/issues/reviews
```

**Common flags (all subcommands):**

| Flag | Description |
|------|-------------|
| `-n, --namespace <ns>` | Namespace (default: `personal`) |
| `--repo <path>` | Repository path (default: `.`) |

**`brain index git`:**

| Flag | Description |
|------|-------------|
| `--commits <n>` | Number of recent commits (default: 50) |

**`brain index ast`:** No extra flags.

**`brain index docs`:**

| Flag | Description |
|------|-------------|
| `--path <paths...>` | Subdirectories to scan (default: `.`) |
| `--enrich` | Use LLM to extract decisions/facts from prose |

**`brain index conversation`:**

| Flag | Description |
|------|-------------|
| `--source <path>` | Conversations directory (default: `~/.claude/projects/`) |
| `--file <path>` | Specific conversation file |
| `--max <n>` | Max conversations (default: 20) |

**`brain index github`:**

| Flag | Description |
|------|-------------|
| `--repo <owner/name>` | GitHub repository (**required**) |
| `--token <pat>` | GitHub PAT (or `GITHUB_TOKEN` env) |
| `--max-prs <n>` | Max PRs (default: 50) |
| `--max-issues <n>` | Max issues (default: 50) |
| `--state <state>` | `open` \| `closed` \| `all` (default: `all`) |
| `--enrich` | LLM extraction from PR descriptions |

---

### Vector Embeddings

#### `brain embed`

```bash
brain embed [options]
```

| Flag | Description |
|------|-------------|
| `-n, --namespace <ns>` | Limit to namespace |
| `--batch-size <n>` | Embeddings per request (default: 64) |
| `--dimensions <n>` | Vector dimensions (default: 768) |

---

### Context Generation

#### `brain recall`

Build a context block for injection into AI sessions.

```bash
brain recall [options]
```

| Flag | Description |
|------|-------------|
| `-s, --session <id>` | Session ID |
| `-q, --query <text>` | Free-text query |
| `-n, --namespace <ns>` | Additional namespace (repeatable) |
| `-l, --limit <n>` | Max entities (default: 15) |

---

### Export & Import

#### `brain export`

```bash
brain export --format <json|json-ld|dot> [options]
```

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `json` \| `json-ld` \| `dot` (**required**) |
| `-n, --namespace <ns>` | Filter by namespace |
| `-o, --output <file>` | Write to file (default: stdout) |

#### `brain import`

```bash
brain import <file> [options]
```

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `json` \| `json-ld` (auto-detected from extension) |
| `--strategy <s>` | `replace` \| `merge` \| `upsert` (default: `upsert`) |
| `-n, --namespace <ns>` | Override namespace |

---

### Monitoring & Live Capture

#### `brain watch`

Run the file-change + branch-change daemon for a wired repo.

```bash
brain watch [options]
```

| Flag | Description |
|------|-------------|
| `--repo <path>` | Repo root (default: cwd) |
| `-n, --namespace <ns>` | Override namespace |
| `--server-url <url>` | Server URL (default: `http://localhost:7430`) |
| `--token <token>` | Bearer token for watcher requests |
| `--author-email <email>` | Override git user.email |
| `--author-name <name>` | Override git user.name |

#### `brain tail`

Tail live sessions from a supported AI CLI.

```bash
brain tail [options]
```

| Flag | Description |
|------|-------------|
| `-t, --tool <tool>` | `copilot` \| `all` (default: `copilot`) |
| `--include-sqlite` | Also run SQLite post-session poller |
| `--idle <minutes>` | Idle window before session-end (default: 15) |

#### `brain poll`

Poll a foreign SQLite store for new sessions.

```bash
brain poll [options]
```

| Flag | Description |
|------|-------------|
| `-t, --tool <tool>` | `codex` (default: `codex`) |
| `--interval <seconds>` | Poll interval (default: 30) |

---

### Hook Management

#### `brain wire-assistant`

Install Second Brain hooks for supported AI assistants.

```bash
brain wire-assistant <claude|cursor|codex|copilot|all> [options]
```

| Flag | Description |
|------|-------------|
| `-s, --scope <scope>` | `user` \| `project` (default: `user`) |
| `--hook-command <cmd>` | Override hook binary path |
| `--dry-run` | Print what would be installed without writing files |

#### `brain unwire-assistant`

```bash
brain unwire-assistant <claude|cursor|codex|copilot|all> [-s <scope>]
```

---

### Repository Wiring

#### `brain wire`

One-shot wire-up: git hooks + claude hooks + config entry + optional forge provider.

```bash
brain wire [options]
```

| Flag | Description |
|------|-------------|
| `--repo <path>` | Repo root (auto-detected) |
| `-n, --namespace <ns>` | Override namespace |
| `--server-url <url>` | Server URL |
| `--token <token>` | Bearer token embedded into local git hooks |
| `--require-project` | Fail without project namespace |
| `--no-claude` | Skip Claude Code hook install |
| `--skip-if-claude-mem` | Abort if `claude-mem` present |
| `--provider <name>` | Forge provider (`gitlab` or `github`) |
| `--gitlab-url <url>` | GitLab base URL |
| `--gitlab-token <pat>` | GitLab PAT |
| `--gitlab-project-path <p>` | `group/subgroup/project` |
| `--github-token <pat>` | GitHub PAT |
| `--github-base-url <url>` | GitHub API base URL |
| `--github-owner <owner>` | GitHub owner/org |
| `--github-repo <repo>` | GitHub repo name |

#### `brain unwire`

Reverse `brain wire` — remove git hooks, drop config, unregister webhook.

```bash
brain unwire [options]
```

| Flag | Description |
|------|-------------|
| `--repo <path>` | Repo root |
| `--remove-claude-hooks` | Also remove Claude hooks (affects all repos) |
| `--purge` | Delete **all** entities and relations in this repo's namespace (irreversible; refuses the `personal` namespace) |
| `-y, --yes` | Skip the `--purge` confirmation prompt (required to purge non-interactively) |
| `--force` | Proceed past provider API failures |

---

### Branch Status Management

#### `brain flip-branch`

Manually flip `branchContext.status` on a branch.

```bash
brain flip-branch <branch> --status <status> [options]
```

| Flag | Description |
|------|-------------|
| `--status <s>` | `wip` \| `merged` \| `abandoned` (**required**) |
| `--mr <iid>` | MR/PR iid |
| `--merged-at <iso>` | ISO timestamp (when `--status=merged`) |

---

### Ownership Analysis

#### `brain ownership`

```bash
brain ownership <path> [options]
```

| Flag | Description |
|------|-------------|
| `-l, --limit <n>` | Max owners (default: 3) |
| `--json` | Output as JSON |
| `--server-url <url>` | Server URL |
| `--token <token>` | Bearer token |

---

### Team Synchronization

#### `brain sync join`

```bash
brain sync join [--namespace <ns>] [--relay <url>] [--secret <s>]
```

| Flag | Description |
|------|-------------|
| `--namespace <ns>` | Project namespace. Defaults to `.second-brain/team.json` `namespace` when present. |
| `--relay <url>` | Relay WebSocket URL (`ws://` or `wss://`). Defaults to `.second-brain/team.json` `server.relayUrl` when present. |
| `--secret <s>` | Shared relay secret. Defaults to `RELAY_AUTH_SECRET`. |

Run inside a repo with a `.second-brain/team.json` to omit `--namespace` and
`--relay`; explicit flags override the manifest values. The relay secret is
never read from the manifest. The `personal` namespace cannot be synced.

#### `brain sync status`

```bash
brain sync status
```

Shows a table: namespace, state (●/○/◐), peers, last synced, errors.

#### `brain sync leave`

```bash
brain sync leave --namespace <ns>
```

---

### Personal Data Management

#### `brain personal export`

```bash
brain personal export -o <file> [--encrypt] [--json]
```

#### `brain personal import`

```bash
brain personal import <file> [--reattach] [--json]
```

#### `brain personal stats`

```bash
brain personal stats [--audit] [--json]
```
