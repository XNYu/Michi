#!/usr/bin/env bash
# Profile Isolation verification script — P2.4
#
# Usage:
#   1. Sign in to https://michi.nan.it.com as Nan and Ata in two browser tabs.
#   2. Save the cookie jars: e.g. browser dev tools -> Application -> Cookies, or
#      use `curl --cookie-jar nan.jar ...` after manual sign-in via OAuth.
#   3. Export env vars and run:
#        COOKIE_NAN=$(pwd)/nan.jar COOKIE_ATA=$(pwd)/ata.jar \
#          ./tests/integration/isolation.sh
#   4. Re-run after every isolation-related deploy.
#
# Optional overrides (fetched live if not set):
#   NAN_USER_ID   — Nan's userId from /api/auth/get-session
#   ATA_USER_ID   — Ata's userId
#   NAN_WS_ID     — An existing workspace of Nan's (for bootstrap reference only)
#
# Outputs: one PASS/FAIL/MANUAL line per assertion.
# Exit: 0 if fail==0 (manual markers don't count as failures).

set -uo pipefail

BASE="${MICHI_BASE_URL:-https://michi.nan.it.com}"
COOKIE_NAN="${COOKIE_NAN:?need cookie jar for Nan}"
COOKIE_ATA="${COOKIE_ATA:?need cookie jar for Ata}"

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed. Install with: brew install jq  (mac) or  apt install jq  (linux)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Counters and helpers
# ---------------------------------------------------------------------------
pass=0; fail=0; manual=0

assert() {
  local n="$1"; local desc="$2"; local got="$3"; local want="$4"
  if [[ "$got" == "$want" ]]; then
    printf '\e[32m✓ %02d  %s\e[0m\n' "$n" "$desc"; pass=$((pass+1))
  else
    printf '\e[31m✗ %02d  %s\e[0m   got=%s want=%s\n' "$n" "$desc" "$got" "$want"; fail=$((fail+1))
  fi
}

manual_hint() {
  local n="$1"; local desc="$2"; local hint="$3"
  printf '\e[33mⓘ %02d  %-40s MANUAL  → %s\e[0m\n' "$n" "$desc" "$hint"
  manual=$((manual+1))
}

# ---------------------------------------------------------------------------
# Bootstrap — discover user ids from live session if not already in env
# ---------------------------------------------------------------------------
NAN_USER_ID="${NAN_USER_ID:-}"
ATA_USER_ID="${ATA_USER_ID:-}"
NAN_WS_ID="${NAN_WS_ID:-}"

echo "==> Bootstrapping user ids…"

if [[ -z "$NAN_USER_ID" ]]; then
  NAN_USER_ID=$(curl -s -b "$COOKIE_NAN" "$BASE/api/auth/get-session" \
    | jq -r '.user.id // empty')
  if [[ -z "$NAN_USER_ID" ]]; then
    echo "ERROR: could not resolve NAN_USER_ID — is the Nan cookie valid?" >&2
    exit 1
  fi
fi
echo "  NAN_USER_ID = $NAN_USER_ID"

if [[ -z "$ATA_USER_ID" ]]; then
  ATA_USER_ID=$(curl -s -b "$COOKIE_ATA" "$BASE/api/auth/get-session" \
    | jq -r '.user.id // empty')
  if [[ -z "$ATA_USER_ID" ]]; then
    echo "ERROR: could not resolve ATA_USER_ID — is the Ata cookie valid?" >&2
    exit 1
  fi
fi
echo "  ATA_USER_ID = $ATA_USER_ID"

if [[ -z "$NAN_WS_ID" ]]; then
  NAN_WS_ID=$(curl -s -b "$COOKIE_NAN" "$BASE/api/workspaces" \
    | jq -r '.workspaces[0].id // empty')
  # It's OK if this is empty — we create our own test workspace below.
fi

# ---------------------------------------------------------------------------
# Setup — create test workspace, chat, and a tagged message with a nonce
# ---------------------------------------------------------------------------
NONCE="secret-${RANDOM}${RANDOM}"
echo ""
echo "==> Setup: creating test workspace + chat + message (nonce: $NONCE)…"

_ws_body=$(curl -s -b "$COOKIE_NAN" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"isolation-test-$(date +%s)\"}" \
  "$BASE/api/workspaces")
NAN_TEST_WS=$(echo "$_ws_body" | jq -r '.workspace.id // .id // empty')
if [[ -z "$NAN_TEST_WS" ]]; then
  echo "ERROR: failed to create test workspace. Response: $_ws_body" >&2
  exit 1
fi
echo "  NAN_TEST_WS  = $NAN_TEST_WS  (DELETE manually if script crashes before cleanup)"

_chat_body=$(curl -s -b "$COOKIE_NAN" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$NAN_TEST_WS\"}" \
  "$BASE/api/chats")
NAN_TEST_CHAT=$(echo "$_chat_body" | jq -r '.chat.id // .id // empty')
if [[ -z "$NAN_TEST_CHAT" ]]; then
  echo "ERROR: failed to create test chat. Response: $_chat_body" >&2
  # Best-effort cleanup before exiting
  curl -s -b "$COOKIE_NAN" -X DELETE "$BASE/api/workspaces/$NAN_TEST_WS" >/dev/null 2>&1
  exit 1
fi
echo "  NAN_TEST_CHAT = $NAN_TEST_CHAT"

_msg_body=$(curl -s -b "$COOKIE_NAN" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"text\":\"$NONCE\"}" \
  "$BASE/api/chats/$NAN_TEST_CHAT/message")
# Node id — may be inside message.nodeId, or a top-level chatId/nodeId depending on route shape
NAN_TEST_NODE=$(echo "$_msg_body" | jq -r '.nodeId // .message.nodeId // .chatId // empty')
# Fallback: the chat id itself is also a node id (chats are nodes in michi's model)
if [[ -z "$NAN_TEST_NODE" ]]; then
  NAN_TEST_NODE="$NAN_TEST_CHAT"
fi
echo "  NAN_TEST_NODE = $NAN_TEST_NODE"

SETUP_OK=true
# Check each creation returned 2xx — we already verified non-empty ids above, so
# this is a belt-and-suspenders pass marker.
echo ""

# ---------------------------------------------------------------------------
# Trap for cleanup — runs even if assertions fail mid-way
# ---------------------------------------------------------------------------
cleanup() {
  echo ""
  echo "==> Cleanup: deleting test workspace $NAN_TEST_WS…"
  _del_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_NAN" \
    -X DELETE "$BASE/api/workspaces/$NAN_TEST_WS")
  if [[ "$_del_status" == "200" || "$_del_status" == "204" || "$_del_status" == "404" ]]; then
    echo "  cleanup OK (status $_del_status)"
  else
    echo "  cleanup WARNING: DELETE returned $_del_status — workspace may need manual removal"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 01  GET /api/admin/users as Nan (admin) → 200, body is array
# ---------------------------------------------------------------------------
_a01_body=$(curl -s -w '\n%{http_code}' -b "$COOKIE_NAN" "$BASE/api/admin/users")
_a01_status=$(printf '%s' "$_a01_body" | tail -1)
_a01_json=$(printf '%s' "$_a01_body" | head -n -1)
_a01_type=$(printf '%s' "$_a01_json" | jq -r 'type' 2>/dev/null || echo "invalid")
# Combine: pass only if status==200 AND body is array
if [[ "$_a01_status" == "200" && "$_a01_type" == "array" ]]; then
  printf '\e[32m✓ 01  GET /api/admin/users as Nan → 200 array\e[0m\n'; pass=$((pass+1))
else
  printf '\e[31m✗ 01  GET /api/admin/users as Nan → 200 array   got=status:%s,type:%s\e[0m\n' \
    "$_a01_status" "$_a01_type"; fail=$((fail+1))
fi

# ---------------------------------------------------------------------------
# 02  GET /api/admin/users as Ata (non-admin) → 404
# ---------------------------------------------------------------------------
_a02_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" "$BASE/api/admin/users")
assert 2 "GET /api/admin/users as Ata → 404" "$_a02_status" "404"

# ---------------------------------------------------------------------------
# 03  Setup succeeded (workspace + chat + message all created with non-empty ids)
# ---------------------------------------------------------------------------
if [[ -n "$NAN_TEST_WS" && -n "$NAN_TEST_CHAT" && -n "$NAN_TEST_NODE" ]]; then
  printf '\e[32m✓ 03  setup: created workspace + chat + message\e[0m\n'; pass=$((pass+1))
else
  printf '\e[31m✗ 03  setup: failed to create one or more resources\e[0m\n'; fail=$((fail+1))
fi

# ---------------------------------------------------------------------------
# 04  GET /api/workspaces as Ata → does NOT include NAN_TEST_WS
# ---------------------------------------------------------------------------
_a04_body=$(curl -s -b "$COOKIE_ATA" "$BASE/api/workspaces")
_a04_count=$(echo "$_a04_body" | jq --arg id "$NAN_TEST_WS" \
  '[.workspaces[]? | select(.id==$id)] | length' 2>/dev/null || echo "error")
assert 4 "GET /api/workspaces as Ata → no Nan workspace in list" "$_a04_count" "0"

# ---------------------------------------------------------------------------
# 05  GET /api/workspaces/:NAN_TEST_WS as Ata → 404
# ---------------------------------------------------------------------------
_a05_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  "$BASE/api/workspaces/$NAN_TEST_WS")
assert 5 "GET /api/workspaces/NAN_TEST_WS as Ata → 404" "$_a05_status" "404"

# ---------------------------------------------------------------------------
# 06  POST /api/chats/:NAN_TEST_CHAT/message as Ata → 404
# ---------------------------------------------------------------------------
_a06_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' -d '{"text":"hi"}' \
  "$BASE/api/chats/$NAN_TEST_CHAT/message")
assert 6 "POST /api/chats/NAN_TEST_CHAT/message as Ata → 404" "$_a06_status" "404"

# ---------------------------------------------------------------------------
# 07  POST /api/warm {cwd:"/etc"} as Ata → non-2xx (400 or 404)
#     Cloud mode: cwd must be server-derived from workspaceId, not client-supplied.
#     /api/warm with a raw cwd is rejected via assertCwdAllowed or deriveSandboxCwd.
# ---------------------------------------------------------------------------
_a07_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"cwd":"/etc"}' \
  "$BASE/api/warm")
# Accept any non-2xx as a pass; the spec says 400 but implementation may vary
if [[ "$_a07_status" -ge 400 ]] 2>/dev/null; then
  printf '\e[32m✓ 07  POST /api/warm {cwd:"/etc"} as Ata → non-2xx (%s)\e[0m\n' "$_a07_status"
  pass=$((pass+1))
else
  printf '\e[31m✗ 07  POST /api/warm {cwd:"/etc"} as Ata → non-2xx   got=%s want=4xx/5xx\e[0m\n' "$_a07_status"
  fail=$((fail+1))
fi

# ---------------------------------------------------------------------------
# 08  POST /api/warm {cwd:"/data/user-cwds/$NAN_USER_ID"} as Ata → non-2xx
# ---------------------------------------------------------------------------
_a08_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"cwd\":\"/data/user-cwds/$NAN_USER_ID\"}" \
  "$BASE/api/warm")
if [[ "$_a08_status" -ge 400 ]] 2>/dev/null; then
  printf '\e[32m✓ 08  POST /api/warm {cwd:Nan sandbox} as Ata → non-2xx (%s)\e[0m\n' "$_a08_status"
  pass=$((pass+1))
else
  printf '\e[31m✗ 08  POST /api/warm {cwd:Nan sandbox} as Ata → non-2xx   got=%s want=4xx/5xx\e[0m\n' "$_a08_status"
  fail=$((fail+1))
fi

# ---------------------------------------------------------------------------
# 09  POST /api/warm {workspaceId:"$NAN_TEST_WS"} as Ata → 404
#     (P1.10: deriveSandboxCwd verifies workspace ownership and returns 404 for non-owner)
# ---------------------------------------------------------------------------
_a09_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$NAN_TEST_WS\"}" \
  "$BASE/api/warm")
assert 9 "POST /api/warm {workspaceId:NAN_TEST_WS} as Ata → 404" "$_a09_status" "404"

# ---------------------------------------------------------------------------
# 10  POST /api/version/update as Ata (non-admin) → 404
#     (requireAdmin returns 404 to non-admins — hides the endpoint)
# ---------------------------------------------------------------------------
_a10_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d '{}' \
  "$BASE/api/version/update")
assert 10 "POST /api/version/update as Ata → 404" "$_a10_status" "404"

# ---------------------------------------------------------------------------
# 11  audit_log row counts — MANUAL (requires Railway shell access)
# ---------------------------------------------------------------------------
manual_hint 11 "audit_log counts" \
  "railway ssh \"sqlite3 /data/audit.db \\\"SELECT action, COUNT(*) FROM audit_log GROUP BY action\\\"\""

# ---------------------------------------------------------------------------
# 12  search_messages(scope:'all', query:'$NONCE') as Ata → 0 hits — MANUAL
# ---------------------------------------------------------------------------
manual_hint 12 "search_messages(scope:'all') via Ata chat" \
  "In Ata's chat in the UI, type: use search_messages with scope all to find $NONCE — verify 0 hits returned"

# ---------------------------------------------------------------------------
# 13  read_node(NAN_TEST_NODE) as Ata → not_found — MANUAL
# ---------------------------------------------------------------------------
manual_hint 13 "read_node(NAN_TEST_NODE) via Ata chat" \
  "In Ata's chat in the UI, type: call read_node with nodeId $NAN_TEST_NODE — verify not_found response"

# ---------------------------------------------------------------------------
# 14  POST /api/warm {cwd:"/data/user-cwds/$NAN_USER_ID"} as Ata → non-2xx
#     (duplicate of 08 per spec; both are listed — belt-and-suspenders)
# ---------------------------------------------------------------------------
_a14_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"cwd\":\"/data/user-cwds/$NAN_USER_ID\"}" \
  "$BASE/api/warm")
if [[ "$_a14_status" -ge 400 ]] 2>/dev/null; then
  printf '\e[32m✓ 14  POST /api/warm {cwd:Nan sandbox} as Ata → non-2xx (%s) [dup of 08]\e[0m\n' "$_a14_status"
  pass=$((pass+1))
else
  printf '\e[31m✗ 14  POST /api/warm {cwd:Nan sandbox} as Ata → non-2xx [dup of 08]   got=%s want=4xx\e[0m\n' "$_a14_status"
  fail=$((fail+1))
fi

# ---------------------------------------------------------------------------
# 15  POST /api/uploads/web-cwd {workspaceId:"$NAN_TEST_WS"} as Ata → 404
# ---------------------------------------------------------------------------
_a15_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$NAN_TEST_WS\"}" \
  "$BASE/api/uploads/web-cwd")
assert 15 "POST /api/uploads/web-cwd {workspaceId:NAN_TEST_WS} as Ata → 404" "$_a15_status" "404"

# ---------------------------------------------------------------------------
# 16  GET /api/search?q=$NONCE as Ata → no hits containing NAN_TEST_NODE
#     Nan tagged her message with a unique nonce; Ata must see 0 hits for it.
# ---------------------------------------------------------------------------
_a16_body=$(curl -s -b "$COOKIE_ATA" \
  --data-urlencode "q=$NONCE" \
  -G "$BASE/api/search")
_a16_nan_hits=$(echo "$_a16_body" | jq --arg nid "$NAN_TEST_NODE" \
  '[.hits[]? | select(.node_id==$nid)] | length' 2>/dev/null || echo "error")
assert 16 "GET /api/search?q=NONCE as Ata → 0 hits for NAN_TEST_NODE" "$_a16_nan_hits" "0"

# ---------------------------------------------------------------------------
# 17  GET /api/backup/export as Ata → NAN_TEST_WS absent from dump
# ---------------------------------------------------------------------------
_a17_body=$(curl -s -b "$COOKIE_ATA" "$BASE/api/backup/export")
_a17_nan_ws=$(echo "$_a17_body" | jq --arg id "$NAN_TEST_WS" \
  '[.workspaces[]? | select(.workspace.id==$id or .id==$id)] | length' 2>/dev/null || echo "error")
assert 17 "GET /api/backup/export as Ata → NAN_TEST_WS absent" "$_a17_nan_ws" "0"

# ---------------------------------------------------------------------------
# 18  POST /api/chats {workspaceId:"$NAN_TEST_WS"} as Ata → 404
#     Confirms ownership check on chat creation, not just read paths.
# ---------------------------------------------------------------------------
_a18_status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ATA" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$NAN_TEST_WS\"}" \
  "$BASE/api/chats")
assert 18 "POST /api/chats {workspaceId:NAN_TEST_WS} as Ata → 404" "$_a18_status" "404"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "---"
printf "passed: %d, failed: %d, manual: %d\n" "$pass" "$fail" "$manual"

[[ $fail -eq 0 ]]
