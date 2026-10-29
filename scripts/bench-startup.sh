#!/usr/bin/env bash
# bench-startup.sh — Automated cold-start benchmark for Michi Electron
# Starts backend, renderer and Electron with electron:dev's environment
# (scripts/electron-dev-env.mjs), captures the startup trace, then stops
# everything after BENCH_DURATION seconds. Unlike electron:dev it builds
# Electron main and native modules before the capture, so their build time
# is not part of the timeline.
# Usage: ./scripts/bench-startup.sh <label> [checkout]
#   checkout: the Michi checkout to build and launch (default: this one)
# Output: logs/startup-<label>.jsonl in the checkout holding this script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure Node 22+ (required for node:sqlite)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 2>/dev/null || true
echo "[bench] node=$(node --version)"

LABEL="${1:-run}"
CHECKOUT="$(cd "${2:-$SCRIPT_DIR/..}" && pwd)"
LOG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/logs"
LOG="$LOG_DIR/startup-${LABEL}.jsonl"
DURATION="${BENCH_DURATION:-25}"

export MICHI_DATA_DIR="${MICHI_DATA_DIR:-$HOME/.michi-dev}"
export MICHI_STARTUP_TRACE=1
export MICHI_STARTUP_RUN_ID="${LABEL}-$(date +%H%M%S)"
export MICHI_METRICS=0

# electron:dev's config dir, instance ID and Electron profile, so the
# benchmark never writes the installed app's ~/.michi config or profile.
DEV_ENV="$(node "$SCRIPT_DIR/electron-dev-env.mjs" "$CHECKOUT")"
while IFS='=' read -r key value; do
  if [[ -n "$key" ]]; then export "$key=$value"; fi
done <<< "$DEV_ENV"

mkdir -p "$LOG_DIR"
> "$LOG"

echo "[bench] label=$LABEL  checkout=$CHECKOUT  log=$LOG  duration=${DURATION}s"
echo "[bench] instance=$MICHI_DEV_INSTANCE_ID  config=$MICHI_CONFIG_DIR"

cd "$CHECKOUT"

# Kill stale processes
node scripts/kill-stale-dev.mjs 2>/dev/null || true

# Build shared + electron main (required)
npm run shared:build 2>/dev/null
npm run electron:build-main 2>/dev/null

# Rebuild native modules for this Node version
npm run electron:rebuild-native 2>/dev/null || true

# Find a free renderer port
RENDERER_PORT=$(node "$SCRIPT_DIR/find-open-port.mjs" "${MICHI_RENDERER_PORT:-3001}")
export MICHI_RENDERER_PORT="$RENDERER_PORT"
export MICHI_RENDERER_URL="http://127.0.0.1:$RENDERER_PORT"

echo "[bench] renderer port=$RENDERER_PORT"

# Backend, renderer and Electron as electron:dev starts them, minus the build
# steps above, piped to tee with a timeout so it auto-kills.
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
node "$SCRIPT_DIR/analyze-startup.mjs" "$LOG" 2>&1 || echo "[bench] analysis failed (check $LOG)"
