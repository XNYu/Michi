#!/usr/bin/env bash
# bench-startup-comparison.sh — Before/after cold-start benchmark
#
# Requires a macOS GUI terminal (Electron needs WindowServer access).
# Run from the repo root:
#   ./scripts/bench-startup-comparison.sh
#
# What it does:
#   1. Stashes the P0/P1/P2 optimizations
#   2. Builds and runs Electron with startup trace → logs/startup-before.jsonl
#   3. Pops the stash (restores optimizations)
#   4. Rebuilds and runs Electron with startup trace → logs/startup-after.jsonl
#   5. Prints a side-by-side comparison
#
# To run just one half:
#   ./scripts/bench-startup-comparison.sh before   # only baseline
#   ./scripts/bench-startup-comparison.sh after    # only optimized
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 2>/dev/null || true

DURATION="${BENCH_DURATION:-30}"
export MICHI_DATA_DIR="${MICHI_DATA_DIR:-$HOME/.michi-dev}"
export MICHI_STARTUP_TRACE=1
export MICHI_METRICS=0

PHASE="${1:-both}"
mkdir -p logs

run_bench() {
  local LABEL="$1"
  local LOG="logs/startup-${LABEL}.jsonl"
  export MICHI_STARTUP_RUN_ID="${LABEL}-$(date +%H%M%S)"
  > "$LOG"

  echo ""
  echo "========================================"
  echo "  Running: $LABEL  (${DURATION}s capture)"
  echo "========================================"

  node scripts/kill-stale-dev.mjs 2>/dev/null || true
  npm run shared:build 2>/dev/null
  npm run electron:build-main 2>/dev/null

  local RENDERER_PORT
  RENDERER_PORT=$(node scripts/find-open-port.mjs "${MICHI_RENDERER_PORT:-3001}")
  export MICHI_RENDERER_PORT="$RENDERER_PORT"
  export MICHI_RENDERER_URL="http://127.0.0.1:$RENDERER_PORT"

  (
    npx concurrently \
      "cd backend && MICHI_REMOTE_ACCESS=0 MICHI_BIND_HOST=127.0.0.1 npm run dev:raw" \
      "cd frontend && npm run dev:raw -- --host 127.0.0.1 --port $RENDERER_PORT" \
      "npx wait-on $MICHI_RENDERER_URL && NODE_OPTIONS= ELECTRON_DEV=1 ./node_modules/.bin/electron electron/dist/main.js" \
      2>&1
  ) | tee "$LOG" &
  local PID=$!

  sleep "$DURATION"

  kill "$PID" 2>/dev/null || true
  pkill -P "$PID" 2>/dev/null || true
  sleep 1
  node scripts/kill-stale-dev.mjs 2>/dev/null || true
  sleep 2

  echo ""
  echo "--- $LABEL results ---"
  node scripts/analyze-startup.mjs "$LOG" 2>&1 || echo "(analysis failed)"
}

if [[ "$PHASE" == "before" || "$PHASE" == "both" ]]; then
  # Stash optimizations to get baseline
  STASHED=false
  if git diff --name-only | grep -q .; then
    git stash push -m "bench-before-stash" \
      -- backend/src/services/dbRepository.ts \
         electron/main.ts \
         frontend/src/components/terminal/TPane.tsx \
         frontend/src/components/terminal/manage/ManageComposer.test.tsx \
         frontend/src/components/terminal/manage/ManageComposer.tsx \
         frontend/src/index.css \
         frontend/viteChunks.ts 2>/dev/null && STASHED=true
  fi

  run_bench "before"

  if $STASHED; then
    git stash pop 2>/dev/null || true
  fi
fi

if [[ "$PHASE" == "after" || "$PHASE" == "both" ]]; then
  run_bench "after"
fi

if [[ "$PHASE" == "both" ]]; then
  echo ""
  echo "============================================"
  echo "  COMPARISON"
  echo "============================================"
  echo ""
  echo "--- BEFORE ---"
  node scripts/analyze-startup.mjs logs/startup-before.jsonl 2>&1 | head -30
  echo ""
  echo "--- AFTER ---"
  node scripts/analyze-startup.mjs logs/startup-after.jsonl 2>&1 | head -30
fi
