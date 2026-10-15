"""Start Michi's MCP host with a supported Node, independent of Crew's PATH.

Crew resolves the manifest's bare Python command to its own interpreter. This
stdlib-only launcher never reads App credentials or edits Crew configuration.
"""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys


def supported_node_version(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value.strip())
    return bool(match and tuple(map(int, match.groups())) >= (22, 19, 0))


def node_candidates(root, env):
    override = env.get("MICHI_CREW_NODE")
    if override:
        return [override]
    candidates = []
    try:
        record = json.loads((root / "backend/dist/crew-node.json").read_text())
        if record.get("schemaVersion") == 1:
            candidates.append(record.get("node", ""))
    except (OSError, ValueError):
        pass
    candidates.extend([shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"])
    home = Path.home()
    mise = Path(env.get("MISE_DATA_DIR") or home / ".local/share/mise")
    patterns = [
        (mise / "installs/node", "*/bin/node"),
        (home / ".nvm/versions/node", "*/bin/node"),
        (home / ".asdf/installs/nodejs", "*/bin/node"),
        (home / ".local/share/fnm/node-versions", "*/installation/bin/node"),
    ]
    for base, pattern in patterns:
        try:
            candidates.extend(str(p) for p in sorted(base.glob(pattern), reverse=True))
        except OSError:
            pass
    if os.name == "nt":
        candidates.extend([str(root / "node/node.exe"), str(root / ".node/node.exe")])
        candidates.extend(str(p) for p in sorted((root / "tools").glob("node-v*-win-*/node.exe"), reverse=True))
        for key in ["ProgramFiles", "LOCALAPPDATA"]:
            if env.get(key):
                candidates.append(str(Path(env[key]) / "nodejs/node.exe"))
    return list(dict.fromkeys(str(p) for p in candidates if p))


def resolve_node(root, env):
    for candidate in node_candidates(root, env):
        if not Path(candidate).is_absolute() or not Path(candidate).is_file():
            continue
        try:
            probe = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=5)
            if probe.returncode == 0 and supported_node_version(probe.stdout):
                return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    raise RuntimeError("Node.js 22.19 or newer was not found. Update Michi or set MICHI_CREW_NODE to a supported Node executable in the App MCP environment.")


def main():
    root = Path(os.environ.get("MICHI_CREW_INSTALL_DIR") or Path.home() / ".michi").resolve()
    host = root / "backend/dist/crewMcpHost.js"
    relay = root / "backend/dist/crewMcp.js"
    if not host.is_file() or not relay.is_file():
        raise RuntimeError("Michi Crew build is missing. Run michi update; for a source checkout, build the backend and use crew-setup.cjs.")
    node = resolve_node(root, os.environ)
    child_env = dict(os.environ)
    # Node's built-in homedir default matches the adapter's binding directory.
    # Custom binding directories are set explicitly by the compatibility helper.
    child = subprocess.Popen([node, str(host)], env=child_env)

    def forward(signum, _frame):
        if child.poll() is None:
            try:
                child.send_signal(signum)
            except OSError:
                pass

    for signum in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(signum, forward)
    result = child.wait()
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print("Michi Crew startup: " + str(error), file=sys.stderr)
        sys.exit(1)
