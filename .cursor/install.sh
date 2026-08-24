#!/usr/bin/env bash
# Durable Cloud Agent bootstrap. Must be idempotent and terminate.
# Installs workspace deps and the Cursor CLI (never Grok's ~/.grok/bin/agent).
set -euo pipefail

npm install

export PATH="${HOME}/.local/bin:${PATH}"

agent_bin="${HOME}/.local/bin/agent"
if [[ ! -x "${agent_bin}" ]]; then
  curl https://cursor.com/install -fsS | bash
fi

if [[ ! -x "${agent_bin}" ]]; then
  echo "ERROR: Cursor CLI was not installed at ${agent_bin}" >&2
  exit 1
fi

agent_real="$(readlink -f "${agent_bin}")"
if [[ "${agent_real}" == *'/.grok/'* ]]; then
  echo "ERROR: ${agent_bin} resolves to the Grok CLI at ${agent_real}" >&2
  exit 1
fi

"${agent_bin}" --version
