#!/usr/bin/env bash
#
# verify-release.sh — operator-side release verification for the checks that
# genuinely require a real OS keychain / a live server / a real IDE session and
# therefore cannot run in CI.
#
# This script is READ-ONLY: it never mints, rotates, deletes, or writes any
# credential, and never restarts a service. It only inspects existing state and
# reports PASS / FAIL / SKIP. The injection latency + cap + context-injection
# logic is covered automatically by:
#   tools/cli/src/__tests__/hook-injection-budget.test.ts
# so this script does NOT re-derive a p95 from hook.log (the current hook.log
# format carries only diagnostic lines, not per-event latencyMs JSON).
#
# Usage:
#   scripts/verify-release.sh [--host HOST] [--server URL]
#
# Defaults: HOST=localhost:7430, SERVER=http://localhost:7430
#
# Exit code: 0 if no check FAILED (SKIPs are allowed), 1 otherwise.

set -u

HOST="localhost:7430"
SERVER="http://localhost:7430"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)   HOST="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

FAILED=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILED=1; }
skip() { printf 'SKIP  %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

CONFIG_DIR="${HOME}/.second-brain"
CREDS_FILE="${CONFIG_DIR}/credentials/${HOST}.json"
HOOK_LOG="${CONFIG_DIR}/hook.log"

printf '== second-brain release verification (host=%s) ==\n\n' "${HOST}"

# ---------------------------------------------------------------------------
# Check #1 — credentials file present and locked down (0600).
# ---------------------------------------------------------------------------
if [ -f "${CREDS_FILE}" ]; then
  MODE=""
  if stat -f '%Lp' "${CREDS_FILE}" >/dev/null 2>&1; then
    MODE="$(stat -f '%Lp' "${CREDS_FILE}")"        # macOS / BSD stat
  elif stat -c '%a' "${CREDS_FILE}" >/dev/null 2>&1; then
    MODE="$(stat -c '%a' "${CREDS_FILE}")"         # GNU stat
  fi
  if [ "${MODE}" = "600" ]; then
    pass "credentials file ${CREDS_FILE} present, mode 0600"
  else
    fail "credentials file mode is ${MODE:-unknown}, expected 600"
  fi
else
  skip "no credentials file at ${CREDS_FILE} (run 'brain init client' first)"
fi

# ---------------------------------------------------------------------------
# Check #1b — keychain round-trip (macOS Keychain / Linux libsecret).
# Reads the stored PAT back out for the token id recorded in credentials.
# ---------------------------------------------------------------------------
TOKEN_ID=""
if [ -f "${CREDS_FILE}" ] && have jq; then
  TOKEN_ID="$(jq -r '.defaultTokenId // empty' "${CREDS_FILE}" 2>/dev/null)"
fi

if [ -z "${TOKEN_ID}" ]; then
  skip "keychain lookup (no token id resolvable from credentials)"
elif have security; then
  # macOS Keychain.app
  if security find-generic-password -s second-brain \
       -a "pat:${HOST}:${TOKEN_ID}" -w >/dev/null 2>&1; then
    pass "keychain holds PAT for pat:${HOST}:${TOKEN_ID} (macOS)"
  else
    fail "keychain has no entry for pat:${HOST}:${TOKEN_ID} (macOS)"
  fi
elif have secret-tool; then
  # Linux libsecret
  if secret-tool lookup service second-brain \
       account "pat:${HOST}:${TOKEN_ID}" >/dev/null 2>&1; then
    pass "keychain holds PAT for pat:${HOST}:${TOKEN_ID} (libsecret)"
  else
    fail "keychain has no entry for pat:${HOST}:${TOKEN_ID} (libsecret)"
  fi
else
  skip "no keychain CLI (security / secret-tool) on PATH"
fi

# ---------------------------------------------------------------------------
# Check #6-adjacent — live-server identity (whoami). Read-only: does NOT
# rotate. Confirms the stored PAT authenticates against the running server.
# ---------------------------------------------------------------------------
if ! have curl; then
  skip "whoami (curl not on PATH)"
elif ! have jq; then
  skip "whoami (jq not on PATH)"
else
  PAT=""
  if [ -n "${TOKEN_ID}" ]; then
    if have security; then
      PAT="$(security find-generic-password -s second-brain \
               -a "pat:${HOST}:${TOKEN_ID}" -w 2>/dev/null || true)"
    elif have secret-tool; then
      PAT="$(secret-tool lookup service second-brain \
               account "pat:${HOST}:${TOKEN_ID}" 2>/dev/null || true)"
    fi
  fi
  if [ -z "${PAT}" ] && [ -n "${BRAIN_AUTH_TOKEN:-}" ]; then
    PAT="${BRAIN_AUTH_TOKEN}"
  fi

  if [ -z "${PAT}" ]; then
    skip "whoami (no PAT available from keychain or BRAIN_AUTH_TOKEN)"
  else
    WHOAMI="$(curl -fsS -H "Authorization: Bearer ${PAT}" \
                "${SERVER}/api/auth/whoami" 2>/dev/null || true)"
    if [ -n "${WHOAMI}" ] && printf '%s' "${WHOAMI}" | jq -e '.userId' >/dev/null 2>&1; then
      UID_VAL="$(printf '%s' "${WHOAMI}" | jq -r '.userId')"
      NS_VAL="$(printf '%s' "${WHOAMI}" | jq -r '.namespace // empty')"
      pass "whoami 200 — userId=${UID_VAL} namespace=${NS_VAL:-?}"
    else
      fail "whoami did not return a userId from ${SERVER}/api/auth/whoami"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Hook log health — NOT a latency p95 (the automated test owns latency). This
# surfaces the diagnostic signal the log actually carries: fetch failures /
# non-2xx server responses since the last firing.
# ---------------------------------------------------------------------------
if [ -f "${HOOK_LOG}" ]; then
  # `grep -c` already prints 0 on no match (and exits 1) — do NOT append a
  # second '0', or a clean log yields ERRORS="0\n0" and a false FAIL.
  ERRORS="$(grep -cE 'fetch failed|server [45][0-9][0-9]|\[stderr\]' "${HOOK_LOG}" 2>/dev/null || true)"
  ERRORS="${ERRORS:-0}"
  TOTAL="$(wc -l < "${HOOK_LOG}" 2>/dev/null | tr -d ' ')"
  if [ "${ERRORS}" -gt 0 ] 2>/dev/null; then
    fail "hook.log has ${ERRORS} error line(s) of ${TOTAL} — inspect: tail -n 20 ${HOOK_LOG}"
  else
    pass "hook.log clean (${TOTAL} lines, 0 errors)"
  fi
else
  skip "no hook.log yet at ${HOOK_LOG} (open a wired IDE session first)"
fi

# ---------------------------------------------------------------------------
# systemd-analyze security (Linux only).
# ---------------------------------------------------------------------------
if have systemd-analyze; then
  printf '\n-- systemd-analyze security second-brain-server --\n'
  systemd-analyze security second-brain-server 2>/dev/null | tail -n 3 || \
    skip "systemd-analyze ran but unit not loaded"
else
  skip "systemd-analyze (not Linux / no systemd) — see manual-verification.md #5"
fi

printf '\n'
if [ "${FAILED}" -eq 0 ]; then
  printf 'RESULT: no failures (SKIPs are environmental).\n'
  exit 0
fi
printf 'RESULT: one or more checks FAILED.\n'
exit 1
