#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the Michi desktop app on macOS.

Options:
  --dir PATH       Install or update the source checkout at PATH.
                   Default: $HOME/Michi
  --repo URL       Git repository to clone.
                   Default: https://github.com/XNYu/Michi.git
  --node VERSION   Node.js 22 version to download if Node 22+ is missing.
                   Default: 22.21.1
  -h, --help       Show this help.

Environment:
  MICHI_INSTALL_DIR   Same as --dir.
  MICHI_REPO_URL      Same as --repo.
  MICHI_NODE_VERSION  Same as --node.
EOF
}

log() {
  printf '[michi] %s\n' "$*"
}

fail() {
  printf '[michi] error: %s\n' "$*" >&2
  exit 1
}

: "${MICHI_INSTALL_DIR:=$HOME/Michi}"
: "${MICHI_REPO_URL:=https://github.com/XNYu/Michi.git}"
: "${MICHI_NODE_VERSION:=22.21.1}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || fail "--dir requires a path"
      MICHI_INSTALL_DIR="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || fail "--repo requires a URL"
      MICHI_REPO_URL="$2"
      shift 2
      ;;
    --node)
      [ "$#" -ge 2 ] || fail "--node requires a version"
      MICHI_NODE_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  fail "the desktop installer currently supports macOS only. For web dev, clone the repo and run 'npm install && npm run dev'."
fi

case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) fail "unsupported macOS architecture: $(uname -m)" ;;
esac

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_command curl
require_command tar
require_command git

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0'
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ]; then
    log "using Node $(node -v)"
    return
  fi

  local tools_dir="$HOME/.michi/tools"
  local node_name="node-v${MICHI_NODE_VERSION}-darwin-${NODE_ARCH}"
  local node_dir="${tools_dir}/${node_name}"
  local node_url="https://nodejs.org/dist/v${MICHI_NODE_VERSION}/${node_name}.tar.gz"

  if [ ! -x "${node_dir}/bin/node" ]; then
    log "downloading Node ${MICHI_NODE_VERSION} for macOS ${NODE_ARCH}"
    mkdir -p "$tools_dir"
    local archive="${tools_dir}/${node_name}.tar.gz"
    curl -fL "$node_url" -o "$archive"
    rm -rf "$node_dir"
    tar -xzf "$archive" -C "$tools_dir"
    rm -f "$archive"
  fi

  export PATH="${node_dir}/bin:${PATH}"

  if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 22 ]; then
    fail "Node 22+ is still unavailable after installing ${node_dir}"
  fi

  log "using Node $(node -v) from ${node_dir}"
}

prepare_checkout() {
  if [ -d "$MICHI_INSTALL_DIR/.git" ]; then
    log "updating ${MICHI_INSTALL_DIR}"
    if [ -n "$(git -C "$MICHI_INSTALL_DIR" status --porcelain)" ]; then
      fail "${MICHI_INSTALL_DIR} has local changes. Commit, stash, or choose another --dir."
    fi
    git -C "$MICHI_INSTALL_DIR" fetch origin main
    git -C "$MICHI_INSTALL_DIR" checkout main
    git -C "$MICHI_INSTALL_DIR" pull --ff-only origin main
    return
  fi

  if [ -e "$MICHI_INSTALL_DIR" ]; then
    fail "${MICHI_INSTALL_DIR} exists but is not a Git checkout. Choose another --dir."
  fi

  log "cloning ${MICHI_REPO_URL} into ${MICHI_INSTALL_DIR}"
  git clone "$MICHI_REPO_URL" "$MICHI_INSTALL_DIR"
}

ensure_node
prepare_checkout

cd "$MICHI_INSTALL_DIR"

log "installing npm dependencies"
npm install

log "building and installing the desktop app"
npm run electron:build

log "done"
log "Michi is installed at $HOME/Applications/michi.app"
log "Open it with: open \"$HOME/Applications/michi.app\""
