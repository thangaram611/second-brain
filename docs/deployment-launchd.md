# Deployment: launchd (macOS)

This guide runs the Second Brain **API server** (`apps/server`) and the
**Yjs relay** (`apps/relay`) as launchd user agents on macOS — convenient for
personal/dev usage where you want services to come up at login and stay up
across crashes.

For Linux production, see [deployment-systemd.md](./deployment-systemd.md).
For one-shot development, `pnpm dev` from the repo root remains the fastest
loop.

---

## Prerequisites

| Requirement | Install |
|-------------|---------|
| macOS 13+ | — |
| Node.js 22+ | `brew install node@22` (then `brew link --overwrite node@22`) |
| pnpm 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| git | preinstalled or `brew install git` |

---

## 1. Clone + build

```bash
git clone https://github.com/<your-org>/second-brain.git ~/code/second-brain
cd ~/code/second-brain
pnpm install
pnpm build
```

---

## 2. Initialize the server

`brain init server` generates both plists (server + relay), writes
`~/.second-brain/secrets.env` (mode 0600) with `RELAY_AUTH_SECRET`,
initializes the SQLite databases, and mints a bootstrap admin PAT.

```bash
pnpm --filter @second-brain/cli build  # if not already built
node tools/cli/dist/index.mjs init server \
  --non-interactive \
  --namespace acme \
  --admin-email admin@example.com
```

The summary it prints includes the exact `launchctl load` lines you'll run in
the next step. It also writes a discoverable config at
`~/.second-brain/server.json` that `brain doctor` reads to know this box is a
server install.

To **rotate** secrets later: re-run with `--force`. The bootstrap admin PAT
is shown one-time only — copy it from the summary; it is not recoverable.

---

## 3. Load both agents

```bash
launchctl load ~/Library/LaunchAgents/dev.secondbrain.server.plist
launchctl load ~/Library/LaunchAgents/dev.secondbrain.relay.plist
```

`RunAtLoad=true` in both plists means each service starts immediately and
again on every login.

Confirm they're running:

```bash
launchctl list | grep secondbrain
# dev.secondbrain.server   <pid>   0
# dev.secondbrain.relay    <pid>   0
```

A pid of `-` and a non-zero exit code means launchd tried but failed — check
the error log (next section).

Quick smoke test:

```bash
brain doctor
# Expect: ✓ local server reachable; ✓ local relay reachable

# Or directly:
curl -fsS http://localhost:7430/health      # server
curl -fsS http://localhost:7421/health      # relay
```

---

## 4. Logs

The auto-generated plists send stdout/stderr under your storage dir:

```bash
tail -f ~/.second-brain/data/logs/server.out.log ~/.second-brain/data/logs/server.err.log
tail -f ~/.second-brain/data/logs/relay.out.log  ~/.second-brain/data/logs/relay.err.log
```

---

## 5. Stop / unload

```bash
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.server.plist
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.relay.plist
```

`unload` removes the agent until next reload — use it before re-running
`brain init server --force` (which rewrites the plists), then `load` again
to pick up changes.

---

## 6. Updating

```bash
cd ~/code/second-brain
git pull
pnpm install
pnpm build

launchctl kickstart -k gui/$(id -u)/dev.secondbrain.server
launchctl kickstart -k gui/$(id -u)/dev.secondbrain.relay
```

`kickstart -k` restarts the service in place. If `brain init server --force`
was run (secrets rotated), unload + load both plists instead — the running
services hold stale signing keys until they restart.

---

## 7. Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.server.plist
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.relay.plist
rm ~/Library/LaunchAgents/dev.secondbrain.server.plist
rm ~/Library/LaunchAgents/dev.secondbrain.relay.plist

# Optional: drop logs + data + secrets + server.json
rm -rf ~/.second-brain
```

---

## Sync URL + secret distribution (manual today)

Each client that runs `brain sync join` needs the relay URL and the shared
secret. Today this is shared out-of-band:

```bash
# On the server box:
grep RELAY_AUTH_SECRET ~/.second-brain/secrets.env
# Share with each client: the relay URL (ws://<host>:7421) and the secret.

# On each client:
brain sync join --namespace acme --relay ws://server.lan:7421 --secret <secret>
```

A future change will extend the team manifest to carry this automatically.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `launchctl list` shows exit code `127` | `nodeBin` path captured by `brain init server` is stale. Re-run `brain init server --force`. |
| Service exits immediately, log says "Cannot find module" | You didn't `pnpm build`, or you `git pull`'d new code without rebuilding. |
| `EADDRINUSE` | Another process holds the port. `lsof -i :7430` / `lsof -i :7421`. |
| `brain doctor` shows ✗ local relay reachable | Run `launchctl load ~/Library/LaunchAgents/dev.secondbrain.relay.plist`. |
| Sync clients are rejected | `RELAY_AUTH_SECRET` mismatch — every `brain sync join` must use the same secret as the server's `secrets.env`. |
| Plist edits don't apply | `launchctl unload` then `launchctl load` — `kickstart` won't reread the file. |
| Service runs once then stops | Check `KeepAlive` in the plist. The default keeps it alive on crash + non-zero exit. |
