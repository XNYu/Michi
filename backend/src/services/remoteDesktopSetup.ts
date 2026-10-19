import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isRemoteCredentialWarning, REMOTE_CREDENTIALS, remoteCredentialCheckPython } from 'michi-shared';
import type { RemoteDiagnosticLog } from './remoteDiagnostics';
import {
  getBackendConnection, listBackendConnections, normalizeBackendConnection,
  probeBackendConnection, saveBackendConnection, type BackendConnectionSummary,
} from './backendConnections';
import { sshTunnelManager, type SshTunnelManager } from './sshTunnelManager';

export class RemoteDesktopError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function parseRemoteHost(raw: string): { sshHost: string; sshUser?: string } {
  const target = raw.trim().replace(/^ssh\s+/, '');
  const match = /^(?:([a-zA-Z0-9_.+-]+)@)?([a-zA-Z0-9_.+:\[\]-]+)$/.exec(target);
  if (!match || target.startsWith('-') || match[2].startsWith('-') || target.length > 255) {
    throw new RemoteDesktopError('invalid_host', 'Enter an SSH alias or user@hostname, without command options.');
  }
  return { sshHost: match[2], sshUser: match[1] };
}

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

type SshTarget = ReturnType<typeof parseRemoteHost> & { sshPort?: number };
type Progress = (stage: string, message: string) => void;
type RunSsh = (target: SshTarget, script: string, signal?: AbortSignal, progress?: Progress, diagnostics?: RemoteDiagnosticLog) => Promise<string>;

export const runRemoteSsh: RunSsh = (target, script, signal, progress, diagnostics) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const args = [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(target.sshPort ? ['-p', String(target.sshPort)] : []),
    target.sshUser ? `${target.sshUser}@${target.sshHost}` : target.sshHost, 'bash -s',
  ];
  const child = spawn(process.env.MICHI_SSH_BIN?.trim() || 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '', errors = '', pending = '', pendingError = '', settled = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const privateKeyStreams = new Set<string>();
  const appendOutput = (source: string, line: string) => {
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(line)) { privateKeyStreams.add(source); diagnostics?.append(source, '[private key omitted]'); }
    else if (!privateKeyStreams.has(source)) diagnostics?.append(source, line);
    if (/-----END [^-]*PRIVATE KEY-----/.test(line)) privateKeyStreams.delete(source);
  };
  diagnostics?.append('ssh command', 'ssh ' + args.join(' '));
  diagnostics?.save();
  const terminate = () => {
    diagnostics?.append('ssh stop', 'Stopping this SSH command and its proxy; sending SIGTERM, then SIGKILL if still running.');
    const kill = (value: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch { /* Already exited. */ }
    };
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 1000).unref();
  };
  const finish = (error?: Error, code?: number | null, exitSignal?: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true; clearTimeout(timeout); clearTimeout(drainTimer);
    signal?.removeEventListener('abort', abort);
    if (pending) appendOutput('ssh stdout', pending);
    if (pendingError) appendOutput('ssh stderr', pendingError);
    diagnostics?.append('ssh exit', `code=${code ?? 'unavailable'} signal=${exitSignal ?? 'none'}${error ? ' · ' + error.message : ''}`);
    diagnostics?.save();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (error) reject(error); else resolve(output);
  };
  const abort = () => { terminate(); finish(signal?.reason instanceof RemoteDesktopError ? signal.reason : new RemoteDesktopError('cancelled', 'Connection cancelled.')); };
  const timeout = setTimeout(() => { terminate(); finish(new RemoteDesktopError('ssh_timeout', 'SSH setup exceeded its 15 minute limit.')); }, 15 * 60_000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); return; }
  child.stdout.on('data', (chunk) => {
    if (settled) return;
    output += String(chunk);
    pending += String(chunk);
    if (output.length > 2_000_000) {
      if (diagnostics) diagnostics.report.truncated = true;
      terminate(); finish(new RemoteDesktopError('output_limit', 'SSH output exceeded the 2 MB capture limit.')); return;
    }
    const lines = pending.split('\n'); pending = lines.pop() ?? '';
    for (const line of lines) {
      appendOutput('ssh stdout', line);
      if (line.startsWith('MICHI_PROGRESS:')) {
        const stage = line.slice('MICHI_PROGRESS:'.length).trim();
        const messages: Record<string, string> = {
          node: 'Preparing Node.js on the remote machine…',
          source: 'Fetching Michi source…', build: 'Installing dependencies and building remotely…',
          start: 'Starting the remote Michi service…',
        };
        if (messages[stage]) progress?.(stage, messages[stage]);
      }
    }
  });
  child.stderr.on('data', chunk => {
    if (settled) return;
    errors += String(chunk); pendingError += String(chunk);
    if (errors.length > 2_000_000) {
      if (diagnostics) diagnostics.report.truncated = true;
      terminate(); finish(new RemoteDesktopError('output_limit', 'SSH output exceeded the 2 MB capture limit.')); return;
    }
    const lines = pendingError.split('\n'); pendingError = lines.pop() ?? '';
    for (const line of lines) appendOutput('ssh stderr', line);
  });
  child.stdin.on('error', () => {});
  child.once('error', error => { diagnostics?.append('ssh spawn', error.stack ?? error.message); terminate(); finish(error); });
  const exited = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    if (settled) return;
    if (code === 0) { finish(undefined, code, exitSignal); return; }
    const fail = (error: Error) => finish(error, code, exitSignal);
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(errors)) {
      fail(new RemoteDesktopError('host_key', 'Verify this host in Terminal with ssh ' + target.sshHost + ', then reconnect.')); return;
    }
    if (/Permission denied|Authentication failed|expired|unauthorized/i.test(errors)) {
      fail(new RemoteDesktopError('ssh_auth', 'SSH authentication needs attention. Sign in with ssh ' + target.sshHost + ', then reconnect.')); return;
    }
    if (/Could not resolve hostname|Name or service not known/.test(errors)) {
      fail(new RemoteDesktopError('ssh_dns', 'The SSH hostname could not be resolved. Check the host or SSH alias.')); return;
    }
    if (/Connection refused/.test(errors)) {
      fail(new RemoteDesktopError('ssh_refused', 'The remote machine refused the SSH connection. Check its SSH service and port.')); return;
    }
    if (/Operation timed out|Connection timed out|No route to host/.test(errors)) {
      fail(new RemoteDesktopError('ssh_network', 'SSH could not reach the remote machine. Check your network or VPN.')); return;
    }
    const known = /MICHI_ERROR:([a-z_]+)/.exec(output + '\n' + errors)?.[1];
    const messages: Record<string, string> = {
      prerequisites: 'The remote machine needs Linux, Python 3, git, curl and tar.',
      node_download: 'Node.js could not be downloaded or verified on the remote machine.',
      node_compatibility: 'Node.js cannot run on this Linux version. A compatible user sysroot or newer Linux image is required.',
      source: 'Could not fetch Michi source. Check repository access on the remote machine.',
      build: 'Remote build failed. Open the diagnostic log for the build output and remote log path.',
      start: 'Michi could not start. Check the remote service log.',
      busy: 'Another Michi setup is running on this machine. Wait for it to finish, then reconnect.',
      modified_source: 'The managed remote checkout has local changes. Preserve them before rebuilding.',
      path: 'The remote folder does not exist or cannot be read.',
      missing_install: 'The existing remote Michi build is missing. Use Connect remote to prepare this machine.',
    };
    fail(new RemoteDesktopError(known ?? 'ssh_failed', messages[known ?? ''] ?? 'Could not reach the remote machine. Check SSH access and try again.'));
  };
  child.once('close', exited);
  child.once('exit', (code, exitSignal) => {
    if (settled) return;
    // Allow buffered output to drain, but never wait forever for proxy-owned pipes.
    drainTimer = setTimeout(() => { terminate(); exited(code, exitSignal); }, 1000);
  });
  child.stdin.end(script);
});

// Output is consumed only by the local gateway. Never forward this object or SSH
// stdout to the renderer: it contains the remote bearer token.
interface RemoteInfo {
  home: string; path: string; repo: string | null; token?: string; port?: number;
  dataDir?: string;
  healthy: boolean; serverId?: string; runtimes: string[]; runtimeWarnings?: string[];
}

const INSPECT_PYTHON = `
import os, json, pathlib, urllib.request, shutil, subprocess, time
home = pathlib.Path.home()
managed = home / '.local/share/michi/devdesktop/source'
candidates = [home / '.michi-remote/remote.env', home / '.michi/remote.env']
result = dict(home=str(home), path=str(home), repo=None, healthy=False, runtimes=[], runtimeWarnings=[])
expected_connection = None
selected_data_dir = None
if selected_data_dir is not None:
    candidates = [pathlib.Path(selected_data_dir).expanduser() / 'remote.env']
${remoteCredentialCheckPython()}for runtime, binary in [('kiro', 'kiro-cli'), ('claude', 'claude'), ('codex', 'codex')]:
    if shutil.which(binary): result['runtimes'].append(runtime)
if 'kiro' in result['runtimes']:
    try:
        identity = subprocess.run(['kiro-cli', 'whoami'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        if identity.returncode != 0:
            result['runtimeWarnings'].append('Kiro is installed but not signed in. Run kiro-cli login on the remote machine before starting a chat.')
    except Exception:
        result['runtimeWarnings'].append('Kiro login could not be verified. Check kiro-cli whoami on the remote machine.')
for repo in [managed, home / '.michi', home / 'michi']:
    if (repo / 'scripts/remote-control.mjs').is_file() and (repo / 'backend/dist/server.js').is_file():
        result['repo'] = str(repo)
        break
selected = None
for file in candidates:
    if not file.is_file(): continue
    env = {}
    for line in file.read_text().splitlines():
        if '=' not in line or line.lstrip().startswith('#'): continue
        key, value = line.split('=', 1)
        try: env[key.strip()] = json.loads(value)
        except ValueError: env[key.strip()] = value.strip().strip(chr(39))
    token = env.get('MICHI_REMOTE_TOKEN', '')
    try: port = int(env.get('PORT', 3000))
    except (ValueError, TypeError): continue
    if len(token) < 16 or not 1 <= port <= 65535: continue
    if expected_connection is not None and (port != expected_connection['port'] or token != expected_connection['token']): continue
    # Keep each directory's identity and owning build together. Without a saved
    # identity, prefer a healthy service, then the first existing installation
    # (legacy one-click installs take precedence when both services are stopped).
    candidate = dict(result, token=token, port=port, dataDir=str(file.parent))
    # Prefer the build that owns this data directory when several checkouts
    # coexist. A stopped process still leaves a useful launcher path behind.
    try:
        record = json.loads((file.parent / 'remote.pid').read_text())
        server = pathlib.Path(record.get('serverPath', ''))
        repo = server.parent.parent.parent
        if server.name == 'server.js' and server.is_file() and (repo / 'scripts/remote-control.mjs').is_file():
            candidate['repo'] = str(repo)
    except (OSError, ValueError, TypeError, AttributeError): pass
    try:
        request = urllib.request.Request('http://127.0.0.1:%d/api/health' % port, headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=2) as response: health=json.load(response)
        if health.get('service') == 'michi-backend' and health.get('status') == 'healthy':
            candidate.update(healthy=True, serverId=health.get('serverId'))
    except Exception: pass
    if selected is None or candidate['healthy']: selected = candidate
    if candidate['healthy']: break
if selected is not None: result = selected
print('MICHI_SETUP_JSON:' + json.dumps(result))
`;

function pythonScript(source: string): string { return `python3 - <<'MICHI_PYTHON'\n${source}\nMICHI_PYTHON\n`; }
function inspectRemoteScript(expected?: { port?: number; token?: string }, dataDir?: string): string {
  let source = expected ? INSPECT_PYTHON.replace('expected_connection = None', `expected_connection = json.loads(${JSON.stringify(JSON.stringify(expected))})`) : INSPECT_PYTHON;
  if (dataDir) source = source.replace('selected_data_dir = None', `selected_data_dir = json.loads(${JSON.stringify(JSON.stringify(dataDir))})`);
  return pythonScript(source);
}
function readRemoteJson<T>(output: string): T {
  const row = output.split('\n').reverse().find(line => line.startsWith('MICHI_SETUP_JSON:'));
  if (!row) throw new RemoteDesktopError('invalid_response', 'The remote machine returned an incomplete setup response.');
  try { return JSON.parse(row.slice('MICHI_SETUP_JSON:'.length)) as T; }
  catch { throw new RemoteDesktopError('invalid_response', 'The remote machine returned an invalid setup response.'); }
}

// Recovery only uses an existing build and its saved environment. It never
// fetches source, installs packages or creates a new token/port.
export function buildRemoteRecoveryScript(info: { repo: string; dataDir: string; expected?: { port?: number; token?: string } }): string {
  return `set -eu
umask 077
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
repo=${shellQuote(info.repo)}
data=${shellQuote(info.dataDir)}
[ -f "$repo/backend/dist/server.js" ] && [ -f "$repo/scripts/remote-control.mjs" ] && [ -f "$data/remote.env" ] || { echo MICHI_ERROR:missing_install; exit 1; }
mkdir "$data/remote-recovery.lock" 2>/dev/null || { echo MICHI_ERROR:busy; exit 1; }
trap 'rmdir "$data/remote-recovery.lock" 2>/dev/null || true' EXIT
node_bin=""
for candidate in "$HOME/.local/share/michi/devdesktop/node/bin/node" "$(command -v node || true)" "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$candidate" ] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then node_bin="$candidate"; break; fi
done
[ -n "$node_bin" ] || { echo MICHI_ERROR:node_compatibility; exit 1; }
export PATH="$(dirname "$node_bin"):$PATH"
export MICHI_DATA_DIR="$data" MICHI_CONFIG_DIR="$data" MICHI_LOG_DIR="$data/logs"
unset PORT MICHI_REMOTE_TOKEN MICHI_BIND_HOST
echo MICHI_PROGRESS:start
cd "$repo"
"$node_bin" scripts/remote-control.mjs launch --no-setup --data-dir "$data" >>"$data/remote-recovery.log" 2>&1 || { echo MICHI_ERROR:start; tail -c 32000 "$data/remote-recovery.log"; exit 1; }
${inspectRemoteScript(info.expected, info.dataDir)}`;
}

export function buildRemoteInstallScript(sourceUrl: string, ref: string, experimentBundle?: string, attemptId?: string, dataDir?: string): string {
  return `set -eu
umask 077
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
root="$HOME/.local/share/michi/devdesktop"
data=${dataDir ? shellQuote(dataDir) : '"$HOME/.michi"'}
for tool in python3 git curl tar; do command -v "$tool" >/dev/null || { echo MICHI_ERROR:prerequisites; exit 1; }; done
[ "$(uname -s)" = Linux ] || { echo MICHI_ERROR:prerequisites; exit 1; }
mkdir -p "$root" "$data"
mkdir "$root/setup.lock" 2>/dev/null || { echo MICHI_ERROR:busy; exit 1; }
trap 'rmdir "$root/setup.lock" 2>/dev/null || true' EXIT
log="$root/setup${attemptId ? "." + attemptId : ""}.log"
touch "$log"; chmod 600 "$log"
echo MICHI_PROGRESS:node
node_bin=""
for candidate in "$(command -v node || true)" "$root/node/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$candidate" ] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then node_bin="$candidate"; break; fi
done
if [ -z "$node_bin" ]; then
  case "$(uname -m)" in aarch64|arm64) arch=arm64;; x86_64) arch=x64;; *) echo MICHI_ERROR:prerequisites; exit 1;; esac
  download="$root/node-download"; mkdir -p "$download"
  if ! (
    cd "$download"
    curl -fsSL --connect-timeout 15 --max-time 60 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
    archive=$(awk -v suffix="linux-$arch.tar.xz" '$2 ~ suffix "$" {print $2; exit}' SHASUMS256.txt)
    [ -n "$archive" ]
    curl -fsSL --connect-timeout 15 --max-time 300 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$archive"
    awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -
    mkdir -p "$root/node"; tar -xJf "$archive" --strip-components=1 -C "$root/node"
  ) >>"$log" 2>&1; then echo MICHI_ERROR:node_download; exit 1; fi
  node_bin="$root/node/bin/node"
fi
# Older Linux machines can provide the isolated VS Code sysroot. Keep the
# downloaded ELF unchanged and use its loader only for Michi's Node processes.
# The preload makes process.execPath point at the wrapper, so npm, the launcher
# and Node subprocesses use it too, without exporting LD_LIBRARY_PATH to CLIs.
if ! "$node_bin" --version >>"$log" 2>&1; then
  case "$(uname -m)" in aarch64|arm64) loader=/opt/vsc-sysroot/lib/ld-linux-aarch64.so.1;; x86_64) loader=/opt/vsc-sysroot/lib/ld-linux-x86-64.so.2;; *) loader="";; esac
  if [ "$node_bin" = "$root/node/bin/node" ] && [ -n "$loader" ] && [ -x "$loader" ]; then
    "$loader" --library-path /opt/vsc-sysroot/lib "$node_bin" --version >>"$log" 2>&1 || { echo MICHI_ERROR:node_compatibility; exit 1; }
    mv "$node_bin" "$root/node/bin/node.elf"
    cat > "$root/node/compat.cjs" <<'MICHI_COMPAT'
process.execPath = require('node:path').join(__dirname, 'bin', 'node');
MICHI_COMPAT
    cat > "$node_bin" <<MICHI_NODE
#!/bin/sh
exec "$loader" --library-path /opt/vsc-sysroot/lib "$root/node/bin/node.elf" --require "$root/node/compat.cjs" "\\$@"
MICHI_NODE
    chmod 700 "$node_bin"
  fi
  "$node_bin" --version >>"$log" 2>&1 || { echo MICHI_ERROR:node_compatibility; exit 1; }
fi
export PATH="$(dirname "$node_bin"):$PATH"
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10'
repo="$root/source"
echo MICHI_PROGRESS:source
if [ ! -d "$repo/.git" ]; then
  staging=$(mktemp -d "$root/source.XXXXXX")
  if ! git clone --single-branch --branch ${shellQuote(ref)} -- ${shellQuote(sourceUrl)} "$staging" >>"$log" 2>&1; then echo MICHI_ERROR:source; exit 1; fi
  ${experimentBundle ? `if ! (git -C "$staging" fetch ${shellQuote(experimentBundle)} 'refs/heads/codex/remote-devdesktop-connect' && git -C "$staging" checkout --detach FETCH_HEAD) >>"$log" 2>&1; then echo MICHI_ERROR:source; exit 1; fi` : ''}
  mv "$staging" "$repo"
else
  [ -z "$(git -C "$repo" status --porcelain --untracked-files=no -- . ':!package-lock.json')" ] || { echo MICHI_ERROR:modified_source; exit 1; }
fi
echo MICHI_PROGRESS:build
export MICHI_DATA_DIR="$data" MICHI_CONFIG_DIR="$data" MICHI_LOG_DIR="$data/logs"
if [ ! -f "$repo/backend/dist/server.js" ]; then
  if ! (cd "$repo" && npm run remote:setup) >>"$log" 2>&1; then echo MICHI_ERROR:build; exit 1; fi
fi
echo MICHI_PROGRESS:start
# Preserve the generated token and port across reconnects. On first launch choose
# an unused loopback port instead of competing with an existing development server.
unset PORT MICHI_REMOTE_TOKEN MICHI_BIND_HOST
if [ ! -f "$data/remote.env" ]; then
  PORT=$("$node_bin" -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  export PORT
fi
if ! (cd "$repo" && "$node_bin" scripts/remote-control.mjs launch --no-setup --data-dir "$data") >>"$log" 2>&1; then echo MICHI_ERROR:start; exit 1; fi
${inspectRemoteScript(undefined, dataDir ?? '~/.michi')}`;
}

export type RemoteSetupResult =
  | { kind: 'install_required'; host: string }
  | { kind: 'connected'; connection: BackendConnectionSummary; home: string; runtimes: string[]; runtimeWarnings: string[] };

export class RemoteDesktopSetup {
  constructor(private readonly deps: { runSsh?: RunSsh; tunnelManager?: SshTunnelManager; sourceUrl?: string; ref?: string } = {}) {}

  async recover(connectionId: string, signal?: AbortSignal, diagnostics?: RemoteDiagnosticLog): Promise<void> {
    const connection = getBackendConnection(connectionId);
    if (!connection || connection.transport !== 'ssh' || !connection.sshHost) {
      throw new RemoteDesktopError('missing_connection', 'Select a saved SSH connection before recovering Michi.');
    }
    const target = { sshHost: connection.sshHost, sshUser: connection.sshUser, sshPort: connection.sshPort };
    const run = this.deps.runSsh ?? runRemoteSsh;
    const tunnels = this.deps.tunnelManager ?? sshTunnelManager;
    diagnostics?.protect(connection.token);
    diagnostics?.stage('ssh', 'Checking the saved remote Michi installation…');
    let info = readRemoteJson<RemoteInfo>(await run(target,
      `set -e\nexport PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"\n${inspectRemoteScript({ port: connection.remotePort, token: connection.token })}`, signal, undefined, diagnostics));
    signal?.throwIfAborted();
    diagnostics?.protect(info.token);
    if (info.port !== connection.remotePort || info.token !== connection.token) {
      throw new RemoteDesktopError('connection_changed', 'The remote port or credentials changed. Connect to this machine again to verify its identity.');
    }
    if (!info.healthy) {
      if (!info.repo || !info.dataDir) throw new RemoteDesktopError('missing_install', 'No existing Michi installation was found. Use Connect remote to prepare this machine.');
      diagnostics?.stage('start', 'Starting the existing remote Michi service…');
      info = readRemoteJson<RemoteInfo>(await run(target, buildRemoteRecoveryScript({ repo: info.repo, dataDir: info.dataDir, expected: { port: connection.remotePort, token: connection.token } }), signal, undefined, diagnostics));
      signal?.throwIfAborted();
      diagnostics?.protect(info.token);
    }
    if (!info.healthy || info.port !== connection.remotePort || info.token !== connection.token) {
      throw new RemoteDesktopError('start', 'The saved remote Michi service did not become healthy. Check its remote-recovery.log and remote.log.');
    }
    if (signal?.aborted) throw new RemoteDesktopError('cancelled', 'Recovery cancelled.');
    tunnels.stop(connectionId);
    diagnostics?.stage('tunnel', 'Opening SSH forwarding…');
    const apiUrl = await tunnels.apiUrl(connection, (source, message) => diagnostics?.append(source, message));
    signal?.throwIfAborted();
    diagnostics?.stage('verify', 'Verifying the recovered SSH connection…');
    const probe = await probeBackendConnection({ apiUrl, token: connection.token, onDiagnostic: message => diagnostics?.append('health probe', message) });
    signal?.throwIfAborted();
    if (!probe.ok) throw new RemoteDesktopError('verify', probe.error);
    if (info.runtimeWarnings?.some(warning => isRemoteCredentialWarning(warning))) {
      throw new RemoteDesktopError('remote_credentials', `${REMOTE_CREDENTIALS.name} credentials on the remote machine have expired. Refresh sign-in before chatting.`);
    }
  }

  async connect(rawHost: string, install: boolean, progress: Progress, signal?: AbortSignal, diagnostics?: RemoteDiagnosticLog): Promise<RemoteSetupResult> {
    const target = parseRemoteHost(rawHost);
    const run = this.deps.runSsh ?? runRemoteSsh;
    const tunnels = this.deps.tunnelManager ?? sshTunnelManager;
    let installStarted = false, remoteInspected = false;
    let remoteDataDir: string | undefined;
    try {
      progress('ssh', 'Connecting to the remote machine…');
      let info = readRemoteJson<RemoteInfo>(await run(target,
        `set -e\nexport PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"\ncommand -v python3 >/dev/null || { echo MICHI_ERROR:prerequisites; exit 1; }\n${pythonScript(INSPECT_PYTHON)}`, signal, undefined, diagnostics));
      diagnostics?.protect(info.token);
      remoteInspected = true;
      remoteDataDir = info.dataDir;
      const expected = info.token && info.port ? { token: info.token, port: info.port } : undefined;
      if (!info.healthy && info.repo && info.dataDir && info.token && info.port) {
        progress('start', 'Starting the existing remote Michi service…');
        info = readRemoteJson<RemoteInfo>(await run(target, buildRemoteRecoveryScript({ repo: info.repo, dataDir: info.dataDir, expected }), signal, progress, diagnostics));
        diagnostics?.protect(info.token);
      }
      if (!info.healthy) {
        if (!install) return { kind: 'install_required', host: rawHost.trim() };
        installStarted = true;
        const installDataDir = remoteDataDir;
        remoteDataDir ??= '~/.michi';
        diagnostics?.append('remote setup log', '~/.local/share/michi/devdesktop/setup.' + diagnostics.report.id + '.log');
        info = readRemoteJson<RemoteInfo>(await run(target, buildRemoteInstallScript(
          this.deps.sourceUrl ?? process.env.MICHI_REMOTE_SOURCE_URL ?? 'https://github.com/XNYu/Michi.git',
          this.deps.ref ?? process.env.MICHI_REMOTE_SOURCE_REF ?? 'main',
          process.env.MICHI_REMOTE_EXPERIMENT_BUNDLE, diagnostics?.report.id, installDataDir,
        ), signal, progress, diagnostics));
        diagnostics?.protect(info.token);
      }
      if (expected && (info.token !== expected.token || info.port !== expected.port)) {
        throw new RemoteDesktopError('connection_changed', 'The remote port or credentials changed during startup. Reconnect to verify the installation.');
      }
      if (!info.healthy || !info.token || !info.port) throw new RemoteDesktopError('start', 'The remote Michi service did not become healthy.');
      progress('tunnel', 'Opening a secure SSH tunnel…');
      diagnostics?.append('remote service', 'Loopback port ' + info.port);
      // Credentials are registered before any tunnel/probe errors are recorded.
      diagnostics?.protect(info.token);
      const existing = listBackendConnections().find(c => c.transport === 'ssh' && c.sshHost === target.sshHost && c.sshUser === target.sshUser && c.remotePort === info.port);
      const candidate = normalizeBackendConnection({
        name: rawHost.trim().replace(/^ssh\s+/, ''), transport: 'ssh', ...target, remotePort: info.port, token: info.token,
      });
      candidate.id = `setup-${randomUUID()}`;
      try {
        const apiUrl = await tunnels.apiUrl(candidate, (source, message) => diagnostics?.append(source, message));
        progress('verify', 'Verifying Michi and saving the connection…');
        const probe = await probeBackendConnection({ apiUrl, token: info.token, onDiagnostic: message => diagnostics?.append('health', message) });
        if (!probe.ok) throw new RemoteDesktopError('verify', probe.error);
        if (signal?.aborted) throw new RemoteDesktopError('cancelled', 'Connection cancelled.');
        // Older remote installations can still default to a missing Kiro CLI.
        // Reuse the remote status and options API, preserving any usable choice.
        // Runtime discovery is advisory: a connected machine remains connected
        // when no runtime is configured or an older API cannot answer.
        progress('runtime', 'Detecting agent runtimes…');
        const runtimeWarnings = [...(info.runtimeWarnings ?? [])];
        try {
          const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
          const statusResponse = await fetch(`${apiUrl}/agent/status`, { headers, signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) });
          if (!statusResponse.ok) throw new Error('Runtime detection returned HTTP ' + statusResponse.status);
          const status = await statusResponse.json() as {
            runtime: string; hasRequiredKey: boolean;
            availableRuntimes: { id: string; label: string; available: boolean; requiresApiKey?: boolean; unavailableReason?: string }[];
          };
          if (!Array.isArray(status.availableRuntimes)) throw new Error('Runtime detection is unavailable on this server.');
          const usable = status.availableRuntimes.filter(runtime => runtime.available
            && (!runtime.requiresApiKey || (runtime.id === status.runtime && status.hasRequiredKey)));
          for (const runtime of status.availableRuntimes) {
            if (!runtime.available && info.runtimes.includes(runtime.id) && runtime.unavailableReason) {
              runtimeWarnings.push(runtime.label + ': ' + runtime.unavailableReason);
            }
          }
          info.runtimes = [...new Set([...info.runtimes, ...usable.map(runtime => runtime.id)])];
          const preferred = usable.find(runtime => runtime.id === status.runtime) ?? usable[0];
          if (preferred && preferred.id !== status.runtime) {
            const response = await fetch(`${apiUrl}/agent/options`, {
              method: 'POST', headers, body: JSON.stringify({ runtime: preferred.id }), signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
            });
            if (!response.ok) throw new Error('Runtime preselection returned HTTP ' + response.status);
            diagnostics?.append('runtime', 'Preselected ' + preferred.id + ' for new conversations');
          }
          diagnostics?.append('runtime', 'Detected ' + info.runtimes.join(', '));
        } catch (error) {
          diagnostics?.append('runtime detection', String(error));
          runtimeWarnings.push('Runtime detection or preselection could not complete. Check the runtime in the composer before starting a chat.');
        }
        if (signal?.aborted) throw new RemoteDesktopError('cancelled', 'Connection cancelled.');
        const connection = saveBackendConnection({
          id: existing?.id, name: candidate.name, transport: 'ssh', ...target, remotePort: info.port, token: info.token,
        });
        return { kind: 'connected', connection, home: info.home, runtimes: info.runtimes, runtimeWarnings };
      } finally { tunnels.stop(candidate.id); }
    } catch (error) {
      if (remoteInspected && diagnostics && !signal?.aborted) {
        // Read only this attempt's setup log. Historical service output is labeled.
        // The original files stay on the host; the report explicitly flags limits.
        try {
          progress(diagnostics.report.stage, 'Collecting remote logs…');
          const collected = await run(target, pythonScript(`
import json, pathlib, shutil, subprocess
home = pathlib.Path.home()
for file in [${[
  ...(installStarted ? [`home / '.local/share/michi/devdesktop/setup.${diagnostics.report.id}.log'`] : []),
  ...(remoteDataDir ? [`pathlib.Path(json.loads(${JSON.stringify(JSON.stringify(remoteDataDir))})).expanduser() / 'remote.log'`] : []),
].join(', ')}]:
    print('REMOTE LOG: ' + str(file))
    if not file.is_file():
        print('[not created]')
        continue
    with file.open('rb') as stream:
        size = file.stat().st_size
        if size > 750000:
            print('[truncated: showing final 750000 bytes; complete log remains on host]')
            stream.seek(size - 750000)
        print(stream.read().decode('utf-8', errors='replace'))
if shutil.which('journalctl'):
    print('SYSTEMD SERVICE LOG (last 300 lines, may include earlier runs)')
    try:
        result = subprocess.run(['journalctl', '--user', '-u', 'michi-remote.service', '-n', '300', '--no-pager', '-o', 'short-iso'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=5)
        output = result.stdout
        if len(output) > 300000: print('[truncated: showing final 300000 bytes]')
        print(output[-300000:].decode('utf-8', errors='replace'))
    except Exception as e: print('Could not read journal: ' + str(e))
`), AbortSignal.timeout(15_000));
          diagnostics.append('remote logs (service log may include earlier runs)', collected);
          if (collected.includes('[truncated:')) diagnostics.report.truncated = true;
        } catch (collectionError) { diagnostics.append('log collection failed', String(collectionError)); }
      }
      throw error;
    }
  }

  async browse(connectionId: string, requestedPath = '~', signal?: AbortSignal): Promise<RemoteDirectory> {
    const connection = getBackendConnection(connectionId);
    if (!connection || connection.transport !== 'ssh' || !connection.sshHost) throw new RemoteDesktopError('connection', 'Select an SSH remote machine first.');
    if (requestedPath.length > 4096 || /[\r\n\0]/.test(requestedPath)) throw new RemoteDesktopError('path', 'Invalid folder path.');
    const source = `
import pathlib, os, json
requested = json.loads(${JSON.stringify(JSON.stringify(requestedPath))})
home = pathlib.Path.home()
folder = pathlib.Path(os.path.expanduser(requested))
if not folder.is_absolute(): folder = home / folder
folder = folder.resolve()
if not folder.is_dir(): raise SystemExit('MICHI_ERROR:path')
entries=[]
try:
    for entry in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
        if entry.name.startswith('.'): continue
        try:
            if entry.is_dir(): entries.append(dict(name=entry.name, path=str(entry)))
        except OSError: pass
        if len(entries) >= 250: break
except OSError: raise SystemExit('MICHI_ERROR:path')
print('MICHI_SETUP_JSON:' + json.dumps(dict(path=str(folder), parent=str(folder.parent) if folder.parent != folder else None, entries=entries)))
`;
    return readRemoteJson<RemoteDirectory>(await (this.deps.runSsh ?? runRemoteSsh)(
      { sshHost: connection.sshHost, sshUser: connection.sshUser, sshPort: connection.sshPort }, pythonScript(source), signal));
  }
}

export interface RemoteDirectory { path: string; parent: string | null; entries: { name: string; path: string }[] }
