# Remote Michi backend

Applies to: self-hosted remote backends connected to the desktop app; Unix shell examples and Linux systemd service steps. Source reviewed: October 16, 2026. This review does not certify a new live deployment or every operating system.

Michi can keep its desktop UI on one machine while running agent sessions and
filesystem tools on another. A workspace is permanently associated with one
backend connection, so local and remote workspaces can be used at the same time.

## Start the remote server

Install Michi and the agent runtimes you want on the remote machine. The public source installation checkout is `~/Michi`; use your actual path if customized. This is the server's installation, not its project workspace. From that directory, run:

```bash
npm run remote:launch
```

This command:

1. installs only the remote-safe backend/shared dependencies;
2. builds the Backend;
3. generates a strong token, or reuses the previously generated token;
4. writes the configuration to `~/.michi/remote.env` with mode `0600`;
5. starts the Backend as a detached background process;
6. waits for `/api/health`, then prints the token, PID, and log path.

The final output includes a copyable line:

```text
MICHI_REMOTE_TOKEN=...
```

Paste that value into **Settings → Connections** in the local Michi app.

To register Michi as a systemd user service instead of using a detached
process:

```bash
npm run remote:launch -- --service
```

The service is written to
`~/.config/systemd/user/michi-remote.service`, enabled immediately, configured
with `Restart=always`, and started in the background. The token remains only in
the protected `~/.michi/remote.env` file; it is not embedded in the unit or
process arguments. The launcher also tries to enable user lingering so the
service survives logout. If the host requires administrator approval, it
prints the exact `loginctl enable-linger USER` command to run.

Lifecycle commands:

```bash
npm run remote:status
npm run remote:restart
npm run remote:stop
npm run remote:service:remove
```

These run against the checkout they are typed in, so after an update they must
be run from the release that is serving. Each launch for the default data
directory instead points `~/.local/bin/michi` at its build, and `michi`
always acts on the build that serves the data directory:

```bash
michi            # start, same as michi start
michi status     # includes the running revision
michi restart
michi stop
michi logs
michi update     # build the latest dev beside the backend, then switch to it
```

`michi update` follows the same steps as **Update remote Michi** below: it
builds in a new directory under `~/.local/share/michi/devdesktop/releases/`
while the current backend keeps running, stops that backend from its own
checkout, starts the new build with the same data directory, port and token,
restarts the old build if the new one does not start, and checks the running
revision. It shares the desktop update's lock, so the two cannot run at once.
`MICHI_REMOTE_SOURCE_URL` and `MICHI_REMOTE_SOURCE_REF` select another source,
and `--data-dir` another installation.

Useful launch options:

```bash
# Different port
npm run remote:launch -- --port 4123

# Rebuild is skipped; reuse the installed backend
npm run remote:launch -- --no-setup

# Explicitly expose the port to a private network/reverse proxy
npm run remote:launch -- --public

# Use an existing token without placing it in shell history
MICHI_REMOTE_TOKEN='your-existing-token' npm run remote:launch
```

Loopback (`127.0.0.1`) is the default and recommended binding for Michi's
built-in SSH tunnel. `--public` binds `0.0.0.0`; use it only behind a firewall,
private network, or HTTPS reverse proxy.

Use Node.js 22.19 or newer. `remote:setup` installs the `backend`, `shared`, `runtime` and `frontend`
workspaces, and builds both the API and the Web UI for phone access. The repository root also contains desktop
dependencies such as `node-pty`; a plain root `npm install` would try to build
those Electron-only modules on Linux even though the remote Backend never uses
them.

Remote mode refuses to start without a token of at least 16 characters. It is
intended for the desktop-to-backend connection mode and cannot be combined with
`MICHI_REQUIRE_AUTH=true`. Remote mode listens on loopback (`127.0.0.1`) unless
`MICHI_BIND_HOST` says otherwise, so the Backend stays private to the server and
Michi reaches it through an SSH tunnel. To listen on a network interface, set
`MICHI_BIND_HOST` explicitly, or pass `--public` to `remote:launch` (which writes
`MICHI_BIND_HOST=0.0.0.0`). Do that only behind a firewall, private network, or
HTTPS reverse proxy: the remote token is then the only thing guarding the API.
Earlier builds listened on every interface when only `MICHI_REMOTE_ACCESS=1` was
set; a setup that connects to such a server directly, without a tunnel, now has
to set `MICHI_BIND_HOST`.

### Manual foreground startup

The lower-level commands remain available for debugging or custom service
management:

```bash
npm run remote:setup
export MICHI_REMOTE_TOKEN="$(openssl rand -hex 32)"
export PORT=3000
export MICHI_BIND_HOST=127.0.0.1
npm run remote:start
```

Unlike `remote:launch`, `remote:start` stays in the foreground and stops when
its terminal ends. It listens on loopback even without `MICHI_BIND_HOST`, so
connect to it through Michi's SSH tunnel. If you manage Michi with a
system-wide service rather than the built-in user-service option, a minimal
unit looks like:

```ini
[Unit]
Description=Michi remote backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/michi
Environment=PORT=3000
Environment=MICHI_REMOTE_ACCESS=1
Environment=MICHI_REMOTE_TOKEN=replace-with-a-long-random-token
Environment=MICHI_BIND_HOST=127.0.0.1
Environment=MICHI_DATA_DIR=/var/lib/michi
ExecStart=/usr/bin/node --experimental-sqlite /opt/michi/backend/dist/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Connect the desktop app

### Connect by host (experimental)

In **New workspace → machine → Connect remote SSH…**, enter an SSH alias
such as `build+`, a hostname, or `user@hostname`, then choose **Connect**. Pasting
`ssh build+` works too. The same flow is available in **Settings → Connections →
Connect remote SSH**. Existing manual SSH and Direct URL settings remain
available under the advanced connection form.

If Michi is already healthy, the local gateway retrieves its connection token
over SSH, verifies the forwarded API and saves the connection. A stopped existing
installation is started using its saved data directory, token and port. If no
usable build is found,
**Install and connect** fetches source from the public Michi GitHub repository's
`main` branch, installs only backend/shared dependencies, builds on the remote
machine and starts the existing background launcher. It prepares Node.js 22
when needed, with a checksum verified against the official Node distribution.
Repeated connections reuse the installation; connecting does not upgrade it.

### Update a connected machine

The Connect flow and **Settings → Connections** compare the remote service with
the local app's build. When the remote commit is an ancestor of the local build,
Michi shows **Remote Michi is older than this app**, both revision IDs, and an
**Update remote Michi** button for SSH connections. Equal versions and unrelated
branches do not produce an update prompt. Missing version information is never
treated as an older version. Existing servers can use their legacy `/api/version`
endpoint until their first update; newer servers report the running build in
health checks, independent of subsequent changes to their source checkout.

Clicking update fetches the exact local build's commit from the gateway's trusted
source repository/ref (the same overrides used for installation), installs only
backend/shared dependencies, and builds in a fresh checkout under
`~/.local/share/michi/devdesktop/releases/`. That commit must already be published
on the configured source branch. A local-only or unavailable commit produces a
source error and leaves the running installation in place. Direct URL connections
show manual/SSH update guidance because they do not provide SSH access.
Local builds with uncommitted app source changes show an explanation instead of
an update button: those changes cannot be reproduced by fetching the commit.

The current service stays running until the build succeeds. Michi then switches
the installation and restarts the remote service, interrupting running chats. It
preserves the selected data directory, database, port and token. A failed build
does not stop the existing service; a failed launch attempts to restore the old
installation. Both checkouts are retained. Local source changes block the update,
and concurrent setup/recovery cannot switch the same installation. After startup,
the local gateway checks the running service's revision before reporting success.

Once accepted, updating continues if its progress dialog closes while the local
gateway stays running. Reopening Settings, switching back to Connections, or
choosing the machine in the Connect flow shows that update's latest progress
instead of another update button, followed by its outcome. The local gateway
keeps the latest outcome until it restarts or the connection is edited or
removed. A duplicate update is rejected while the first one runs; a view that
receives that rejection follows the running update instead of reporting a
failure. Failures retain the usual diagnostic controls; the remote
build log is `~/.local/share/michi/devdesktop/update.<attempt-id>.log`. The selected
installation is recorded in `<data-dir>/remote-installation.json`, allowing later
recovery to use the updated checkout in background or systemd service mode.

### Connected runtimes and folders

The managed checkout, downloaded Node.js and private setup logs are in
`~/.local/share/michi/devdesktop/`. New installations keep their database,
configuration, token (`remote.env`) and service logs in `~/.michi/`, matching
the manual `npm run remote:launch` default. Existing installations using
`~/.michi-remote/` continue using that directory, including when preparing a
missing managed build. Connecting never moves, merges or deletes either
directory's data.

Recovery of a saved connection matches its port and token before checking
health, so a stopped installation cannot be replaced by another installation's
configuration. For a new connection by host, discovery prefers a healthy
installation; when both are stopped, it prefers the existing `~/.michi-remote/`
installation. Startup verification and service-log collection stay with the
selected directory. The service listens on loopback and chooses an unused port
on first launch. The renderer receives progress and redacted connection
metadata only, never the SSH response containing the token.

After connecting, Michi shows the number and names of detected runtimes, such
as **Detected 2 runtimes: Codex, Claude Code**. There is no runtime selection
step. Michi keeps an available current runtime, or preselects the first usable
runtime for new conversations. Users can change it in the composer when starting
a chat; existing conversations retain their own runtime binding. Kiro CLI is
optional: a remote machine can use Codex, Claude Code, or another configured
runtime independently. An API runtime such as Pi needs configured provider
credentials before it can become the automatic default.

A machine with no detected runtimes can still connect and browse folders. Michi
shows a setup notice; install and authenticate the desired agent on the remote
machine before chatting. Detection indicates installation or configuration, not
a successful model response. Runtime status/preselection failures are recorded
in diagnostics and shown as warnings without discarding the machine connection.
Warnings include the same **View logs**, **Copy diagnostics**, and (when a local
runtime is ready) **Ask local agent** controls as failures. The saved attempt
report includes the warning and setup output; the controls remain available
while choosing a remote folder.

Browse remote folders, choose **Use this folder**, then
create the workspace. Paths are resolved on the remote machine, including
symlinks and `~`. Existing remote workspaces are imported without reloading the
app; late imports preserve newly created workspaces and current focus.

**Settings → Connections** reads each machine's current workspace list from its
remote backend whenever the pane opens. **Refresh workspaces** reads it again;
the list and count are not inferred from locally hydrated workspaces or saved as
a local inventory. While reading, the pane shows progress. A failed or timed-out
read shows an error and **Retry workspaces**, without displaying a stale list or
claiming the machine has zero workspaces. Each connection loads independently.
This list refresh does not replace open conversations or drafts. Newly discovered
workspaces are listed immediately; workspace links are available once that
workspace has been loaded from the matching remote connection.

This prototype uses Linux, Bash, Python 3, git, curl, tar and working
noninteractive SSH. It retains strict host-key checks: first-login/host-key or
expired SSH authentication requires user interaction. The desktop app now opens
a dedicated sign-in terminal when SSH authentication fails. On older Linux
machines with `/opt/vsc-sysroot`, a private Node wrapper uses that
existing loader and a preload to preserve Node subprocess startup. It does not
replace system libraries or export a library path to agent CLIs. Without a
compatible Node/sysroot, setup reports a compatibility error.

The launcher uses detached background mode here. Automatic systemd supervision,
host discovery, runtime installation
and unattended updates are not part of this experiment. Agent runtime readiness
and authentication must still be configured on the remote machine. Setup checks
Kiro's login status separately and reports a warning when its CLI is installed
but not signed in. A successful connection is not a successful model-response test.

### Sign-in and service recovery

The sign-in commands and credential checks come from the build's remote
credential provider (`shared/src/remoteCredentials.ts`, mirrored for the native
terminal in `electron/remoteCredentials.ts`). When SSH authentication fails,
Michi opens a small native terminal running the provider's local sign-in command,
then checks SSH again. SSH key/configuration errors can require additional
correction; refreshing sign-in does not prove the SSH identity is valid. When the
provider defines a remote sign-in command, an expired remote credential cookie at
connection time, or a matching credential error from a remote runtime, makes the
terminal run that command on the remote machine over interactive SSH instead.
The dialog states which machine is being authenticated. Host-key verification stays strict;
an unknown or changed host must be verified separately.

The user enters credentials directly in the terminal and completes any browser,
OTP or security-key steps. Authentication terminal output is ephemeral, is not
saved in diagnostic logs, and is not sent to agents. When the sign-in command
exits successfully and Michi reconnects, the dialog closes by itself. A failed
sign-in or reconnection keeps it open with the error and **Try sign-in again**.
Cancel/close destroys that terminal process. A cancelled prompt can be reopened
from the sign-in notice.
Browsers and older desktop builds show a selectable/copyable command and a
reconnect button. The desired agent runtime must still be installed and signed in.

If a request through a saved SSH connection fails, the local gateway first
checks the existing connection. A healthy forward stays open; transport failures
are handled by its SSH supervisor. When service recovery is needed, the gateway
checks the installation over SSH and starts its existing build. A rejected saved
credential requires sign-in or connection correction, not repeated tunnel
restarts. Concurrent requests share one recovery attempt,
with a 45-second timeout and a 30-second automatic retry cooldown. Recovery
reuses the saved data directory, port and token; it does not download source,
install dependencies, upgrade, or silently adopt changed credentials. A missing
installation requires the normal **Install and connect** flow. Direct URL
connections cannot be started through SSH.

Startup and verification failures appear in connection diagnostics, including
sanitized SSH output and the saved local report path. Remote launch failures
include the last 32,000 characters of `remote-recovery.log`. Once the service
recovers, workspace loading resumes without replacing active drafts. Requests
and chat messages are never automatically resent after an ambiguous failure;
the user can retry a failed chat after the connection is ready.

Failed connections show the failing stage and an expandable diagnostic. **Copy
diagnostics** copies the attempt ID, host, timestamps, error code, actual exception,
SSH stdout/stderr and exit status, tunnel details and health-check result. If
clipboard access fails, the log opens as selectable text. Network interruptions
retain the received progress and try to retrieve the saved attempt from the local
gateway.

The local gateway keeps the most recent 20 attempt reports under
`<MICHI_LOG_DIR or ~/.michi/logs>/remote-connections/<attempt-id>.json` with mode
0600. Setup protocol records and credentials are redacted before saving or sending
to the renderer. Installation logs use
`~/.local/share/michi/devdesktop/setup.<attempt-id>.log` on the host. On failure,
the gateway also tries to collect that attempt's setup log, the background service
log and the last 300 systemd journal lines. Service logs may contain earlier runs
and are labeled accordingly. A failed collection is recorded without replacing
the original error. Capture limits are explicit: 2 million characters per SSH
output stream, 750 KB per remote file, 300 KB of journal output, and 4 million
characters per local report. Complete remote files remain on the host; truncated
captures are marked. Reports can contain hostnames, paths and source/build output.

When a local runtime is available, **Ask local agent** opens a new conversation in
the local Chats workspace and sends a diagnostic prompt using that runtime's
configured provider/model. This also works when the selected workspace is remote.
It rechecks local availability on click and does not change the default runtime.
The prompt asks for read-only investigation first and treats logs as untrusted
data. Long reports use a labeled prompt excerpt; the saved report and full copy
remain available. Without a ready local runtime, viewing and copying diagnostics
still work.

For development, the local gateway can override its trusted source with
`MICHI_REMOTE_SOURCE_URL` and `MICHI_REMOTE_SOURCE_REF`. To test an unpushed
worktree, `MICHI_REMOTE_EXPERIMENT_BUNDLE` names a Git bundle already placed on
the remote host: after cloning `main`, setup fetches its
`codex/remote-devdesktop-connect` ref and checks out that commit before building.
These settings are gateway environment variables, not renderer inputs.

### Built-in SSH tunnel (recommended)

1. In Terminal on the desktop machine, run `ssh HOST` once. Complete any
   first-login authentication and accept the server host key.
2. Open **Settings → Connections** and choose **SSH tunnel**.
3. Enter the SSH host or `~/.ssh/config` alias. The SSH user and SSH port are
   optional; blank values use your SSH config/defaults.
4. Enter the remote Michi port (`3000` by default) and the same remote token.
5. Test and save the connection.
6. Create a workspace, select the remote backend, and enter an absolute path
   that exists on the remote server.

The bundled local Backend starts an `ssh -N -T -C -L` process on demand. Arguments
are passed directly without a shell. Michi relies on `~/.ssh/config`, known
hosts, and ssh-agent; it never stores an SSH password or private key. Concurrent
requests reuse one compressed, persistent tunnel. A supervisor checks end-to-end
transport reachability every 15 seconds, and after desktop wake. Three failed
probes replace an unresponsive forward; process exit also triggers recovery
without waiting for another renderer request. Retries use exponential backoff
with a six-attempt budget. Only a successful end-to-end probe resets that budget.
HTTP authentication or service errors do not by themselves tear down a working
SSH transport. The child owns its forwarding socket without sharing a user SSH
ControlMaster, while still using the user's SSH routing and identities.

Closing Michi stops the local SSH process. It does not stop the remote Backend
or cancel remote turns. Reopening Michi recreates the tunnel on the next remote
request and reconnects to durable remote state.

### Direct URL

Choose **Direct URL** for a server already reachable through Tailscale, a
private network, an HTTPS reverse proxy, or an approved tunnel service. Example
URLs include `https://michi.example.com` and `http://100.64.0.10:3000`.

The server must listen on the interface that URL reaches. Remote mode binds
loopback by default, so set `MICHI_BIND_HOST` to that interface's address (for
example the Tailscale address `100.64.0.10`), or use `remote:launch -- --public`
to bind every interface. Prefer the specific address, and keep the port behind
a firewall or private network. A reverse proxy on the same host can keep the
loopback default.

Connection tokens and non-secret SSH connection settings are stored by the local bundled backend in
`~/.michi/config.json` with file mode `0600`. They are not returned to the
renderer. Requests from the renderer go through the bundled backend's streaming
proxy, which adds the token server-side.

## Lifecycle behavior

- Local workspaces use the bundled backend as before.
- Remote workspaces use the selected remote backend for persistence, sessions,
  messages, SSE replay, files, uploads, digests, search, and agent settings.
- The app keeps one background event subscription per connected backend, so
  local and remote self-initiated turns can run together.
- Closing or reloading the app detaches its SSE subscribers and stops any local
  SSH tunnel processes. It does not send a cancel request and does not stop the
  remote backend. Reopening the app recreates tunnels on demand, loads the
  durable remote state, and reattaches to turns that are still running.
- The native Terminal and raw folder browser remain local-only. In a remote
  workspace, use agent shell tools and chat artifacts to work with server files.

### Background workspace recovery

A temporary outage keeps already-loaded conversations, unsent drafts and replay
cursors in memory. After metadata becomes available, the event feed resumes
from those cursors; a replay gap uses an authoritative server snapshot. A single
failed request is confirmed with a bounded health check before the connection
is marked unavailable. Saved connection edits invalidate the old cache and
pending responses, including token-only edits. A renderer reload still needs
the remote to answer: remote conversation bodies are not stored in localStorage
or copied into the Local database.

Remote trees initially fetch the newest 50 messages per node. **Load older
messages** reads the preceding page and keeps the reader's position. Sending,
retrying, editing, digest generation and export fetch any required missing
history before using it as full context. Older servers that do not support
pagination continue to return complete history. Deploy the updated remote
backend as well as the desktop client to get the smaller initial payload.

If a saved remote machine cannot load its workspaces at startup, or a newly
connected machine cannot import its workspaces, a persistent notice identifies
that machine, shows the latest error, and indicates automatic retries. Local
workspaces remain usable. **Try again** wakes the retry delay without starting
a concurrent recovery request. The notice clears automatically when the remote
workspace list loads, including a valid empty list. Removing a connection or
closing the renderer cancels its pending recovery work and clears the notice.

The notice offers **View logs**, **Copy diagnostics**, and **Ask local agent**
when a local runtime is ready. Recovery diagnostics contain the client request
errors, HTTP/gateway details, timestamps and retry history for that machine;
they do not collect remote service files. This in-memory history keeps the
latest 32,000 characters, marks truncation, and is cleared on recovery or reload.
Credentials are redacted before display, copy or agent handoff. Each machine's
recovery is tracked separately and retries do not steal workspace focus.

## Network security

Do not expose the plain HTTP port directly to the public internet. Prefer one
of these:

- Michi's built-in SSH tunnel with the remote Backend bound to loopback;
- Tailscale/WireGuard/private VPC networking;
- an HTTPS reverse proxy with firewall rules.

Rotate `MICHI_REMOTE_TOKEN` if it is disclosed. Updating the token requires
editing the saved connection in Settings. The remote SQLite database and agent
processes remain entirely on the server.
