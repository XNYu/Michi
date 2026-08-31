#!/usr/bin/env bash
# bench-startup.sh — Automated cold-start benchmark for Michi Electron
# Mirrors the real electron:dev flow but auto-kills after capture.
# Usage: ./scripts/bench-startup.sh <label>
# Output: logs/startup-<label>.jsonl
set -euo pipefail

# Ensure Node 22+ (required for node:sqlite)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 2>/dev/null || true
echo "[bench] node=$(node --version)"

LABEL="${1:-run}"
LOG="logs/startup-${LABEL}.jsonl"
DURATION="${BENCH_DURATION:-25}"

export MICHI_DATA_DIR="${MICHI_DATA_DIR:-$HOME/.michi-dev}"
export MICHI_STARTUP_TRACE=1
export MICHI_STARTUP_RUN_ID="${LABEL}-$(date +%H%M%S)"
export MICHI_METRICS=0

mkdir -p logs
> "$LOG"

echo "[bench] label=$LABEL  log=$LOG  duration=${DURATION}s"

# Kill stale processes
node scripts/kill-stale-dev.mjs 2>/dev/null || true

# Build shared + electron main (required)
npm run shared:build 2>/dev/null
npm run electron:build-main 2>/dev/null

# Rebuild native modules for this Node version
npm run electron:rebuild-native 2>/dev/null || true

# Find a free renderer port
RENDERER_PORT=$(node scripts/find-open-port.mjs "${MICHI_RENDERER_PORT:-3001}")
export MICHI_RENDERER_PORT="$RENDERER_PORT"
export MICHI_RENDERER_URL="http://127.0.0.1:$RENDERER_PORT"

echo "[bench] renderer port=$RENDERER_PORT"

# Run the exact same concurrently command as electron:dev, piping to tee
# but with a timeout so it auto-kills.
(
  npx concurrently \
    "cd backend && MICHI_REMOTE_ACCESS=0 MICHI_BIND_HOST=127.0.0.1 npm run dev:raw" \
    "cd frontend && npm run dev:raw -- --host 127.0.0.1 --port $RENDERER_PORT" \
    "npx wait-on $MICHI_RENDERER_URL && NODE_OPTIONS= ELECTRON_DEV=1 ./node_modules/.bin/electron electron/dist/main.js" \
    2>&1
) | tee "$LOG" &
MAIN_PID=$!

# Wait for the capture duration
sleep "$DURATION"

echo ""
echo "[bench] capture complete, killing processes..."
kill "$MAIN_PID" 2>/dev/null || true
pkill -P "$MAIN_PID" 2>/dev/null || true
sleep 1
node scripts/kill-stale-dev.mjs 2>/dev/null || true
sleep 2

echo ""
echo "============================================"
echo "  STARTUP ANALYSIS: $LABEL"
echo "============================================"
node scripts/analyze-startup.mjs "$LOG" 2>&1 || echo "[bench] analysis failed (check $LOG)"
