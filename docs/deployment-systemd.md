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
| Node.js | 22+ | [nodesource](https://github.com/nodesource/distributions), `nvm`, or your distro's package manager |
| pnpm | 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| git | 2.x | distro package |
| Service user | non-root | `sudo useradd --system --create-home --shell /bin/bash secondbrain` |

Capture the absolute paths for the service unit:

```bash
which node    # → e.g. /usr/bin/node                       — <NODE_BIN>
which pnpm    # → e.g. /usr/local/bin/pnpm                  — <PNPM_BIN>
id -un        # → e.g. secondbrain                          — <USER>
```

---

## 1. Install the code

Clone and build the monorepo as `<USER>`:

```bash
sudo -iu secondbrain
git clone https://github.com/<your-org>/second-brain.git /opt/second-brain
cd /opt/second-brain
pnpm install
pnpm build
exit
```

Use `/opt/second-brain` as `<INSTALL_DIR>` throughout this guide. Any path
readable+writable by `<USER>` works.

Create the runtime data directory (used for the SQLite DB and relay state):

```bash
sudo install -d -o secondbrain -g secondbrain /var/lib/second-brain
sudo install -d -o secondbrain -g secondbrain /var/lib/second-brain/relay
```

---

## 2. Create env files

systemd loads env files **before** `ExecStart`. Keep one file per service.

### `/etc/second-brain/server.env`

```bash
sudo install -d -m 0750 -o root -g secondbrain /etc/second-brain
sudo tee /etc/second-brain/server.env > /dev/null <<'EOF'
NODE_ENV=production

# Ports
BRAIN_API_PORT=7430

# Database
BRAIN_DB_PATH=/var/lib/second-brain/personal.db

# LLM provider — adjust for your environment
BRAIN_LLM_PROVIDER=ollama
BRAIN_LLM_BASE_URL=http://localhost:11434
BRAIN_LLM_MODEL=llama3.2

# Auth (optional but recommended for any non-loopback exposure)
# BRAIN_AUTH_TOKEN=replace-me
EOF
sudo chmod 0640 /etc/second-brain/server.env
sudo chown root:secondbrain /etc/second-brain/server.env
```

### `/etc/second-brain/relay.env`

```bash
sudo tee /etc/second-brain/relay.env > /dev/null <<'EOF'
NODE_ENV=production
RELAY_PORT=7421
RELAY_PERSIST_DIR=/var/lib/second-brain/relay

# REQUIRED — shared secret all sync clients must present.
RELAY_AUTH_SECRET=replace-with-a-strong-shared-secret
EOF
sudo chmod 0640 /etc/second-brain/relay.env
sudo chown root:secondbrain /etc/second-brain/relay.env
```

> **Note on `start` scripts.** The unit files invoke
> `pnpm --filter @second-brain/server start` (and the same for the relay).
> The `start` script lands in `apps/server/package.json` as part of a separate
> stream. Until then, replace the `ExecStart=` line with a direct node
> invocation (commented in the unit file):
>
> ```
> ExecStart=<NODE_BIN> <INSTALL_DIR>/apps/server/dist/index.mjs
> ```

---

## 3. Install the unit files

```bash
sudo cp /opt/second-brain/apps/server/systemd/second-brain-server.service \
        /etc/systemd/system/second-brain-server.service
sudo cp /opt/second-brain/apps/relay/systemd/second-brain-relay.service \
        /etc/systemd/system/second-brain-relay.service
```

Open each file and replace the placeholders:

| Placeholder | Example |
|-------------|---------|
| `<USER>` | `secondbrain` |
| `<INSTALL_DIR>` | `/opt/second-brain` |
| `<NODE_BIN>` | `/usr/bin/node` |
| `<PNPM_BIN>` | `/usr/local/bin/pnpm` |

A one-liner using `sed` (run as root):

```bash
sudo sed -i \
  -e 's#<USER>#secondbrain#g' \
  -e 's#<INSTALL_DIR>#/opt/second-brain#g' \
  -e 's#<NODE_BIN>#/usr/bin/node#g' \
  -e 's#<PNPM_BIN>#/usr/local/bin/pnpm#g' \
  /etc/systemd/system/second-brain-server.service \
  /etc/systemd/system/second-brain-relay.service
```

Verify the units are syntactically correct:

```bash
sudo systemd-analyze verify /etc/systemd/system/second-brain-server.service
sudo systemd-analyze verify /etc/systemd/system/second-brain-relay.service
```

---

## 4. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now second-brain-server.service
sudo systemctl enable --now second-brain-relay.service
```

Confirm both are active:

```bash
sudo systemctl status second-brain-server
sudo systemctl status second-brain-relay
```

---

## 5. Inspect logs

systemd routes stdout/stderr to the journal:

```bash
# Live tail
sudo journalctl -u second-brain-server -f
sudo journalctl -u second-brain-relay -f

# Last hour, no follow
sudo journalctl -u second-brain-server --since "1 hour ago"

# Errors only
sudo journalctl -u second-brain-server -p err
```

---

## 6. Updating

```bash
sudo -iu secondbrain
cd /opt/second-brain
git pull
pnpm install
pnpm build
exit

sudo systemctl restart second-brain-server second-brain-relay
```

---

## 7. Uninstall

```bash
sudo systemctl disable --now second-brain-server second-brain-relay
sudo rm /etc/systemd/system/second-brain-server.service
sudo rm /etc/systemd/system/second-brain-relay.service
sudo systemctl daemon-reload

# Optional: remove env files and data
sudo rm -rf /etc/second-brain /var/lib/second-brain
sudo rm -rf /opt/second-brain
sudo userdel -r secondbrain
```

---

## Reverse proxy (optional)

Either service can sit behind nginx/Caddy/Traefik for TLS termination.
The server speaks HTTP+WebSocket on `BRAIN_API_PORT` (default `7430`); the
relay speaks WebSocket on `RELAY_PORT` (default `7421`). Forward both `Upgrade`
and `Connection` headers so WebSocket connections survive.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `status=203/EXEC` | `<PNPM_BIN>` or `<NODE_BIN>` path is wrong; check `which pnpm`. |
| `EADDRINUSE` on `7430`/`7421` | Another process holds the port — `sudo ss -lntp \| grep 7430`. |
| Permission denied on DB | `<USER>` cannot write to `BRAIN_DB_PATH`; `sudo chown -R secondbrain /var/lib/second-brain`. |
| Relay rejects clients | `RELAY_AUTH_SECRET` mismatch between server env file and clients. |
| Service flapping | `journalctl -u <name> -n 200` and look for the error before each `Stopped`/`Started`. |
