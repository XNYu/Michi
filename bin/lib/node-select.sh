# Node.js selection shared by install.sh (after it clones the repository) and
# bin/michi. Source it from bash.
#
# Michi's minimum Node version is "engines.node" in the root package.json,
# written as ">=X.Y.Z". scripts/remote-control.mjs and crew-app/launch.py read
# the same field.

# Prints the minimum version (X.Y.Z) from <repo>/package.json.
michi_node_minimum() {
  local version
  # Plain sed so it works before any Node is chosen; the file is joined into
  # one line so the match does not depend on its formatting.
  version="$(tr -d '\n' 2>/dev/null < "$1/package.json" | sed -n \
    's/.*"engines"[[:space:]]*:[[:space:]]*{[^}]*"node"[[:space:]]*:[[:space:]]*">=\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p')" || true
  [ -n "$version" ] || return 1
  printf '%s\n' "$version"
}

# Drop app-bundled Node binaries (e.g. Codex.app) from PATH. Those Node
# copies are signed with hardened runtime but without
# `com.apple.security.cs.disable-library-validation`, so dlopen of prebuilt
# native addons like @rolldown/binding-darwin-arm64 fails with
# "different Team IDs".
michi_scrub_app_bundled_nodes_from_path() {
  PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -viE '(/Applications/.*\.app/|/Codex\.app/)' | paste -sd ':' - || true)"
  export PATH
  hash -r 2>/dev/null || true
}

# michi_node_meets_minimum <node> <X.Y.Z>
michi_node_meets_minimum() {
  "$1" -e '
const want = process.argv[1].split(".").map(Number);
const have = process.versions.node.split(".").map(Number);
for (let i = 0; i < 3; i += 1) if (have[i] !== want[i]) process.exit(have[i] > want[i] ? 0 : 1);' "$2" 2>/dev/null
}

michi_node_can_load_native() {
  local node_bin="$1"
  [ -x "$node_bin" ] || return 1

  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi

  local signature
  signature="$(codesign -dv "$node_bin" 2>&1 || true)"

  # Only hardened-runtime binaries enforce library validation. Homebrew's
  # ad-hoc Node has no Team ID and can load npm native addons normally.
  if ! printf '%s\n' "$signature" | grep -q 'flags=.*runtime'; then
    return 0
  fi

  codesign -d --entitlements - "$node_bin" 2>&1 | \
    grep -q 'com.apple.security.cs.disable-library-validation'
}

michi_candidate_nodes() {
  command -v node 2>/dev/null
  [ -x /opt/homebrew/bin/node ] && printf '%s\n' /opt/homebrew/bin/node
  [ -x /usr/local/bin/node ] && printf '%s\n' /usr/local/bin/node
  if [ -d "${NVM_DIR:-$HOME/.nvm}/versions/node" ]; then
    find "${NVM_DIR:-$HOME/.nvm}/versions/node" -path '*/bin/node' \( -type f -o -type l \) 2>/dev/null | sort -r
  fi
  if command -v mise >/dev/null 2>&1; then
    mise where node 2>/dev/null | sed 's|$|/bin/node|'
  fi
  if [ -d "$HOME/.local/share/mise/installs/node" ]; then
    find "$HOME/.local/share/mise/installs/node" -path '*/bin/node' \( -type f -o -type l \) 2>/dev/null | sort -r
  fi
}

# michi_select_node <X.Y.Z> [preferred node...]
# Picks the first candidate (preferred ones first) at or above the minimum
# that can load native addons, sets MICHI_NODE and MICHI_NODE_DIR, and puts
# that directory first on PATH. Returns 1 when none qualifies.
michi_select_node() {
  local minimum="$1" cand
  shift
  michi_scrub_app_bundled_nodes_from_path
  MICHI_NODE=""
  MICHI_NODE_DIR=""
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    [ -x "$cand" ] || continue
    michi_node_meets_minimum "$cand" "$minimum" || continue
    if michi_node_can_load_native "$cand"; then
      MICHI_NODE="$cand"
      break
    fi
  done < <({ [ "$#" -eq 0 ] || printf '%s\n' "$@"; michi_candidate_nodes; } | awk '!seen[$0]++')

  [ -n "$MICHI_NODE" ] || return 1
  MICHI_NODE_DIR="$(cd "$(dirname "$MICHI_NODE")" && pwd)"
  PATH="$MICHI_NODE_DIR:$PATH"
  export PATH
  hash -r 2>/dev/null || true
}
