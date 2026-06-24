# Deployment: systemd (Linux)

This guide walks a Linux administrator through running the Second Brain
**API server** (`apps/server`) and the **Yjs relay** (`apps/relay`) as
long-lived systemd services.

For local macOS development, see [deployment-launchd.md](./deployment-launchd.md).
For one-shot development (no service manager), `pnpm dev` from the repo root
remains the fastest path.

---

## Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| Linux with systemd | any modern distro | — |
| Node.js | 24+ | [nodesource](https://github.com/nodesource/distributions), `nvm`, or your distro's package manager |
| pnpm | 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| git | 2.x | distro package |

---

## 1. Create the service user

The systemd unit's `User=` value is supplied via `--service-user <name>`.
Create that account first; it does not need a login shell or a home directory.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin secondbrain
```

---

## 2. Clone + build

```bash
sudo git clone https://github.com/<your-org>/second-brain.git /opt/second-brain
sudo chown -R secondbrain:secondbrain /opt/second-brain
sudo -u secondbrain bash -c 'cd /opt/second-brain && pnpm install && pnpm build'
```

---

## 3. Initialize the server

`brain init server` writes:

- `/etc/second-brain/secrets.env` (mode 0640, `root:secondbrain`) — carries
  `BRAIN_SERVER_SIGNING_KEY`, `BRAIN_INVITE_SIGNING_KEY`, `RELAY_AUTH_SECRET`.
- `/etc/systemd/system/second-brain-server.service`
- `/etc/systemd/system/second-brain-relay.service`
- `/var/lib/second-brain/{brain.db,users.db,relay/,logs/}` (owned by the
  service user).
- `<root's $HOME>/.second-brain/server.json` — discoverable config that
  `brain doctor` reads on this box.

**Linux has exactly one supported invocation pattern.** The CLI refuses to
proceed otherwise:

```bash
sudo node /opt/second-brain/tools/cli/dist/index.mjs init server \
  --service-user secondbrain \
  --non-interactive \
  --namespace acme \
  --admin-email admin@example.com
```

Common preflight errors:

| Error | Cause | Fix |
|-------|-------|-----|
| `Linux: \`brain init server\` … requires root.` | Ran without `sudo`. | Re-run with `sudo`. |
| `Linux: \`--service-user <name>\` is required …` | Ran as root but no `--service-user`. | Pass `--service-user secondbrain` (or your chosen account). |

The bootstrap admin PAT is shown one-time only — copy it from the summary;
it is not recoverable.

To **rotate** secrets later: re-run with `--force`. The DBs are preserved.

---

## 4. Enable and start

`brain init server` prints the exact commands at the end of its summary:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now second-brain-server
sudo systemctl enable --now second-brain-relay
```

Verify the units (optional):

```bash
sudo systemd-analyze verify /etc/systemd/system/second-brain-server.service
sudo systemd-analyze verify /etc/systemd/system/second-brain-relay.service
```

Confirm both are active:

```bash
sudo systemctl status second-brain-server
sudo systemctl status second-brain-relay
```

Quick smoke test:

```bash
sudo -i brain doctor                # reads /root/.second-brain/server.json
# Expect: ✓ local server reachable; ✓ local relay reachable

curl -fsS http://localhost:7430/health      # server
curl -fsS http://localhost:7421/health      # relay
```

---

## 5. Logs

systemd routes stdout/stderr to the journal:

```bash
sudo journalctl -u second-brain-server -f
sudo journalctl -u second-brain-relay -f

sudo journalctl -u second-brain-server --since "1 hour ago"
sudo journalctl -u second-brain-server -p err
```

---

## 6. Updating

```bash
sudo -u secondbrain bash -c 'cd /opt/second-brain && git pull && pnpm install && pnpm build'
sudo systemctl restart second-brain-server second-brain-relay
```

If `brain init server --force` was run (secrets rotated), restart both
services so they pick up the new keys.

---

## 7. Uninstall

```bash
sudo systemctl disable --now second-brain-server second-brain-relay
sudo rm /etc/systemd/system/second-brain-server.service
sudo rm /etc/systemd/system/second-brain-relay.service
sudo systemctl daemon-reload

# Storage + secrets (root-owned)
sudo rm -rf /etc/second-brain /var/lib/second-brain
sudo rm -rf /opt/second-brain
sudo rm -rf /root/.second-brain          # server.json + per-root state
sudo userdel secondbrain
```

---

## Reverse proxy (optional)

Either service can sit behind nginx/Caddy/Traefik for TLS termination.
The server speaks HTTP+WebSocket on `BRAIN_API_PORT` (default `7430`); the
relay speaks WebSocket on `RELAY_PORT` (default `7421`). Forward both
`Upgrade` and `Connection` headers so WebSocket connections survive.

---

## Sync onboarding

Clients never handle `RELAY_AUTH_SECRET`. The API server holds it (sourced from
the same `/etc/second-brain/secrets.env` as the relay) and mints the relay token
itself for an authenticated client. Commit the relay URL to the team repo as
`server.relayUrl` in `.second-brain/team.json` so clients can omit `--relay` and
`--namespace` too.

```bash
# On each client, inside a repo whose team.json includes server.relayUrl:
brain sync join

# Or pass everything explicitly (explicit flags override the manifest):
brain sync join --namespace acme --relay ws://server.lan:7421
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `status=203/EXEC` | Node binary captured at init time is stale; re-run `sudo brain init server --service-user secondbrain --force`. |
| `EADDRINUSE` on `7430`/`7421` | Another process holds the port — `sudo ss -lntp \| grep 7430`. |
| `Permission denied` on DB | `secondbrain` cannot write storage; `sudo chown -R secondbrain:secondbrain /var/lib/second-brain`. |
| Relay rejects clients | The API server and relay have different `RELAY_AUTH_SECRET` values — both must read the same `/etc/second-brain/secrets.env`. |
| `brain sync join` returns 503 | The API server has no `RELAY_AUTH_SECRET` in its environment — ensure its unit sources `/etc/second-brain/secrets.env`. |
| Service flapping | `sudo journalctl -u <name> -n 200` and look for the error before each `Stopped`/`Started`. |
| `brain doctor` shows ✗ local server config (unreadable) | `~/.second-brain/server.json` is malformed; re-run `sudo brain init server --service-user secondbrain --force`. |
