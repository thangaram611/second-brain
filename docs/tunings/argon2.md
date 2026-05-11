# Argon2id tuning (PAT password hashing)

Second Brain hashes Personal Access Token (PAT) secrets with **argon2id** (the
hybrid variant — RFC 9106). The cost parameters are env-configurable so
operators can size the hash to their hardware budget without recompiling.

## TL;DR

| Profile | `BRAIN_ARGON2_M` | `BRAIN_ARGON2_T` | `BRAIN_ARGON2_P` | When to use |
|---|---|---|---|---|
| **Default** (recommended)        | `65536` (64 MiB) | `3` | `1` | Any host with ≥256 MiB free RAM per request |
| **Small VPS** (cheapest accepted) | `19456` (19 MiB) | `2` | `1` | Tiny VMs (1 GiB RAM, shared CPU) |
| **High-mem alternative**          | `47104` (46 MiB) | `1` | `1` | Hosts with abundant RAM but little CPU |

The server **refuses to boot** if the configured params fall below BOTH OWASP
baselines (see below).

## OWASP baselines

The OWASP Password Storage Cheat Sheet (2025) lists two equivalent argon2id
profiles. Either is acceptable; the server only rejects when **both** are
violated.

- **High-mem profile:** `m ≥ 47104 (46 MiB)`, `t ≥ 1`, `p ≥ 1`
- **Low-mem profile:** `m ≥ 19456 (19 MiB)`, `t ≥ 2`, `p ≥ 1`

These are derived from the same target cost (~50 ms on contemporary hardware)
with memory and time traded off against each other. RFC 9106 §4 gives the
underlying analysis; the second profile is the "memory-constrained" one
recommended for IoT and small-VPS deployments.

## Why the default is `p=1`

Using `p=4` can spread argon2's lane parallelism across CPU cores, but three
things make it a worse default than `p=1`:

1. **Libuv thread pool exhaustion** — node-argon2 runs each hash on a libuv
   worker. With the default pool size of 4, a single concurrent login burst
   pinned all four workers and starved unrelated I/O (file reads, DNS).
2. **OWASP, RFC 9106, and node-argon2 all default to `p=1`** unless the
   operator has measured a benefit on their specific server.
3. **Bitwarden uses `p=1`** in production for the same reason — predictable
   single-thread cost.

You can still set `BRAIN_ARGON2_P=4` on a beefy server with a tuned libuv
pool (`UV_THREADPOOL_SIZE=16+`), but it is not the default.

## Small-VPS recommendation

If your server runs on a 1-vCPU / 1 GiB-RAM VM (e.g., a $5 droplet) and you
expect bursts of concurrent login attempts, the **low-mem OWASP profile**
keeps each verify under ~30 ms while leaving headroom for the rest of the
request:

```bash
# /etc/second-brain/secrets.env (or your launchd/systemd EnvironmentFile)
BRAIN_ARGON2_M=19456
BRAIN_ARGON2_T=2
BRAIN_ARGON2_P=1
```

**Tradeoff:** lowering `m` linearly reduces the cost an attacker pays per
guess on memory-bound hardware (GPU/ASIC). At `m=19 MiB` you're still well
above bcrypt-style cost, but if your threat model includes a sophisticated
offline attacker with custom hardware, prefer the default `m=65536` profile.

## Verification

A `users` service test parses the encoded hash prefix
(`$argon2id$v=19$m=<m>,t=<t>,p=<p>$…`) and asserts the operator-supplied
params actually flow through to the hashes on disk. A second test asserts
that env values below both OWASP baselines fail at startup with an
actionable error naming the offending variable(s).

## Changing params after PATs exist

If you change `BRAIN_ARGON2_*` after users have minted PATs, the verify path
enforces the new policy: existing hashes that fall below it will be rejected,
and the user must rotate their PAT (`brain auth rotate`).

## References

- OWASP Password Storage Cheat Sheet — <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- RFC 9106 (Argon2) — <https://datatracker.ietf.org/doc/html/rfc9106>
- node-argon2 README — <https://github.com/ranisalt/node-argon2>
- Bitwarden hashing notes — <https://bitwarden.com/help/bitwarden-security-white-paper/>
