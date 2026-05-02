# Deployment: launchd (macOS)

This guide runs the Second Brain **API server** (`apps/server`) and the
**Yjs relay** (`apps/relay`) as launchd user agents on macOS — convenient for
personal/dev usage where you want services to come up at login and stay up
across crashes.

For Linux production, see [deployment-systemd.md](./deployment-systemd.md).
For one-shot development, `pnpm dev` from the repo root is still the fastest
loop.

---

## Prerequisites

| Requirement | Install |
|-------------|---------|
| macOS 13+ | — |
| Node.js 22+ | `brew install node@22` (then `brew link --overwrite node@22`) |
| pnpm 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| git | preinstalled or `brew install git` |

Capture absolute paths — launchd does **not** read your shell rc files, so the
plist must use full paths:

```bash
which node    # → e.g. /opt/homebrew/bin/node              — __NODE_BIN__
which pnpm    # → e.g. /opt/homebrew/bin/pnpm              — __PNPM_BIN__
echo $HOME    # → e.g. /Users/yourname                     — __HOME__
pwd           # (from the cloned repo)                      — __INSTALL_DIR__
```

---

## 1. Install the code

```bash
git clone https://github.com/<your-org>/second-brain.git ~/code/second-brain
cd ~/code/second-brain
pnpm install
pnpm build
```

`__INSTALL_DIR__` is `~/code/second-brain` resolved to its absolute form
(launchd does not expand `~`).

> **Note on `start` scripts.** The plists invoke
> `pnpm --filter @second-brain/server start` (and the same for the relay). The
> `start` script lands in `apps/server/package.json` as part of a separate
> stream. Until then, swap the `<array>` block in the plist for a direct node
> call (the comment inside the file shows the exact replacement).

---

## 2. Customize the plists

The templates live in:

- `apps/server/launchd/dev.secondbrain.server.plist`
- `apps/relay/launchd/dev.secondbrain.relay.plist`

Each contains `__PLACEHOLDER__` markers. Make a copy and substitute:

```bash
mkdir -p ~/Library/LaunchAgents

# Server
sed \
  -e "s#__PNPM_BIN__#$(which pnpm)#g" \
  -e "s#__NODE_BIN__#$(which node)#g" \
  -e "s#__INSTALL_DIR__#$HOME/code/second-brain#g" \
  -e "s#__HOME__#$HOME#g" \
  apps/server/launchd/dev.secondbrain.server.plist \
  > ~/Library/LaunchAgents/dev.secondbrain.server.plist

# Relay — provide a shared secret too
sed \
  -e "s#__PNPM_BIN__#$(which pnpm)#g" \
  -e "s#__NODE_BIN__#$(which node)#g" \
  -e "s#__INSTALL_DIR__#$HOME/code/second-brain#g" \
  -e "s#__HOME__#$HOME#g" \
  -e "s#__RELAY_AUTH_SECRET__#replace-with-a-strong-secret#g" \
  apps/relay/launchd/dev.secondbrain.relay.plist \
  > ~/Library/LaunchAgents/dev.secondbrain.relay.plist
```

Validate the result:

```bash
plutil -lint ~/Library/LaunchAgents/dev.secondbrain.server.plist
plutil -lint ~/Library/LaunchAgents/dev.secondbrain.relay.plist
```

Both should print `OK`.

---

## 3. Load the agents

```bash
launchctl load ~/Library/LaunchAgents/dev.secondbrain.server.plist
launchctl load ~/Library/LaunchAgents/dev.secondbrain.relay.plist
```

`RunAtLoad=true` means each service starts immediately and again on every login.

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
curl -fsS http://localhost:7430/health      # server
curl -fsS http://localhost:7421/health      # relay (or whatever its health path is)
```

---

## 4. Logs

The plists send stdout/stderr to `/tmp/`:

```bash
tail -f /tmp/second-brain-server.out.log /tmp/second-brain-server.err.log
tail -f /tmp/second-brain-relay.out.log  /tmp/second-brain-relay.err.log
```

You can change the destinations by editing `StandardOutPath` /
`StandardErrorPath` in the plist (e.g. `~/Library/Logs/second-brain-server.log`).

---

## 5. Stop / unload

```bash
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.server.plist
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.relay.plist
```

`unload` removes the agent until next reload — use it before editing a plist,
then `load` again to pick up changes.

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

`kickstart -k` restarts the service in place; no need to unload/reload unless
you edited the plist itself.

---

## 7. Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.server.plist
launchctl unload ~/Library/LaunchAgents/dev.secondbrain.relay.plist
rm ~/Library/LaunchAgents/dev.secondbrain.server.plist
rm ~/Library/LaunchAgents/dev.secondbrain.relay.plist

# Optional: drop logs and data
rm -f /tmp/second-brain-*.log
rm -rf ~/.second-brain
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `launchctl list` shows exit code `127` | The `__PNPM_BIN__` substitution missed; re-run the `sed` block. |
| Service exits immediately, log says "Cannot find module" | `WorkingDirectory` is wrong, or you didn't run `pnpm build`. |
| `EADDRINUSE` | Another process holds the port. `lsof -i :7430` / `lsof -i :7421`. |
| Relay refuses sync clients | `RELAY_AUTH_SECRET` in the plist must match what every `brain sync join` client uses. |
| Plist edits don't apply | `launchctl unload` then `launchctl load` — `kickstart` won't reread the file. |
| Service runs once then stops | Check `KeepAlive`. The default keeps it alive on crash + non-zero exit; tweak as needed. |
