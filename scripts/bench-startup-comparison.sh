#!/usr/bin/env bash
# bench-startup-comparison.sh — Before/after cold-start benchmark
#
# Requires a macOS GUI terminal (Electron needs WindowServer access).
#   ./scripts/bench-startup-comparison.sh [both|before|after] [base-ref]
#
# What it does:
#   1. Checks out <base-ref> (default HEAD) into a temporary detached git
#      worktree and runs `npm ci` there
#   2. Runs scripts/bench-startup.sh on that checkout
#      → logs/startup-before.jsonl
#   3. Runs scripts/bench-startup.sh on this checkout, uncommitted changes
#      included → logs/startup-after.jsonl
#   4. Prints a side-by-side comparison
#   5. Removes the temporary worktree, also on failure or Ctrl-C
#
# This checkout's files, index and stashes are never modified.
#
# To run just one half:
#   ./scripts/bench-startup-comparison.sh before origin/main   # only baseline
#   ./scripts/bench-startup-comparison.sh after               # only this checkout
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 2>/dev/null || true

DURATION="${BENCH_DURATION:-30}"

PHASE="${1:-both}"
BASE_REF="${2:-HEAD}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

BASE_PARENT=""
BASE_DIR=""
cleanup() {
  if [[ -n "$BASE_DIR" && -d "$BASE_DIR" ]]; then
    # Stop dev processes still running from the base checkout before removing it.
    (cd "$BASE_DIR" && node scripts/kill-stale-dev.mjs >/dev/null 2>&1) || true
    git -C "$ROOT" worktree remove --force "$BASE_DIR" ||
      echo "[bench] could not remove $BASE_DIR; remove it with: git worktree remove --force $BASE_DIR" >&2
  fi
  git -C "$ROOT" worktree prune 2>/dev/null || true
  if [[ -n "$BASE_PARENT" ]]; then
    rmdir "$BASE_PARENT" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# One capture with this checkout's bench-startup.sh, which owns the launch
# command and electron:dev's environment, against the given checkout.
run_bench() {
  BENCH_DURATION="$DURATION" bash "$ROOT/scripts/bench-startup.sh" "$@"
}

if [[ "$PHASE" == "before" || "$PHASE" == "both" ]]; then
  # Baseline from a separate checkout of BASE_REF, not from this working tree.
  BASE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/michi-bench-base.XXXXXX")"
  BASE_DIR="$BASE_PARENT/michi"
  echo "[bench] checking out $BASE_REF into $BASE_DIR"
  git -C "$ROOT" worktree add --detach "$BASE_DIR" "$BASE_REF"
  (cd "$BASE_DIR" && npm ci --no-audit --no-fund)
  # The base checkout's path changes every run; a fixed instance keeps one
  # Electron profile for it instead of a new one per run.
  MICHI_DEV_INSTANCE_ID="${MICHI_DEV_INSTANCE_ID:-bench-base}" run_bench "before" "$BASE_DIR"
fi

if [[ "$PHASE" == "after" || "$PHASE" == "both" ]]; then
  run_bench "after" "$ROOT"
fi

if [[ "$PHASE" == "both" ]]; then
  echo ""
  echo "============================================"
  echo "  COMPARISON"
  echo "============================================"
  echo ""
  echo "--- BEFORE ---"
  node "$ROOT/scripts/analyze-startup.mjs" "$LOG_DIR/startup-before.jsonl" 2>&1 | head -30
  echo ""
  echo "--- AFTER ---"
  node "$ROOT/scripts/analyze-startup.mjs" "$LOG_DIR/startup-after.jsonl" 2>&1 | head -30
fi
