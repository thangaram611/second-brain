# @second-brain/relay

Hocuspocus-based Yjs CRDT relay that powers real-time, multi-user sync of a
namespace's knowledge graph. Listens on `RELAY_PORT` (default `7421`) for
y-websocket-compatible clients.

See [`AGENTS.md`](./AGENTS.md) for the architecture overview.

## Run locally

```bash
# From the repo root — hot-reload dev mode
RELAY_AUTH_SECRET=my-shared-secret pnpm --filter @second-brain/relay dev

# Or build + run the bundled output
pnpm --filter @second-brain/relay build
node apps/relay/dist/index.mjs
```

The relay is also started by `pnpm dev` at the repo root alongside the API
server and UI.

## Required environment

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_AUTH_SECRET` | — (**required**) | Shared secret all sync clients must present. |
| `RELAY_PORT` | `7421` | TCP port for the WebSocket + HTTP listener. |
| `RELAY_PERSIST_DIR` | `~/.second-brain/relay` | Directory for `.ystate` snapshots. |

The `personal` namespace is rejected by design — it is reserved for local-only
data.

## Production deployment

The relay is meant to run as a long-lived service. Two ready-to-edit unit
templates ship with the repo:

| Platform | Template | Guide |
|----------|----------|-------|
| Linux (systemd) | [`systemd/second-brain-relay.service`](./systemd/second-brain-relay.service) | [docs/deployment-systemd.md](../../docs/deployment-systemd.md) |
| macOS (launchd) | [`launchd/dev.secondbrain.relay.plist`](./launchd/dev.secondbrain.relay.plist) | [docs/deployment-launchd.md](../../docs/deployment-launchd.md) |

Both templates expose clear `<PLACEHOLDER>` / `__PLACEHOLDER__` markers that
admins replace at install time.
