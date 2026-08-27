# Remote Michi backend

Michi can keep its desktop UI on one machine while running agent sessions and
filesystem tools on another. A workspace is permanently associated with one
backend connection, so local and remote workspaces can be used at the same time.

## Start the remote server

Install Michi and the agent runtimes you want on the remote machine, then run
one command from the repository root:

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

Use Node.js 22.19 or newer. `remote:setup` intentionally installs only the
`backend` and `shared` workspaces. The repository root also contains desktop
dependencies such as `node-pty`; a plain root `npm install` would try to build
those Electron-only modules on Linux even though the remote Backend never uses
them.

Remote mode refuses to start without a token of at least 16 characters. It is
intended for the desktop-to-backend connection mode and cannot be combined with
`MICHI_REQUIRE_AUTH=true`. `MICHI_BIND_HOST=127.0.0.1` keeps the Backend private
to the server when Michi reaches it through SSH. If you intentionally use a
private network or reverse proxy, bind the interface required by that setup.

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
its terminal ends. If you manage Michi with a system-wide service rather than
the built-in user-service option, a minimal unit looks like:

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

The bundled local Backend starts an `ssh -N -T -L` process on demand. Arguments
are passed directly without a shell. Michi relies on `~/.ssh/config`, known
hosts, and ssh-agent; it never stores an SSH password or private key. Concurrent
requests reuse one tunnel. If SSH exits, the next request starts it again.

Closing Michi stops the local SSH process. It does not stop the remote Backend
or cancel remote turns. Reopening Michi recreates the tunnel on the next remote
request and reconnects to durable remote state.

### Direct URL

Choose **Direct URL** for a server already reachable through Tailscale, a
private network, an HTTPS reverse proxy, or an approved tunnel service. Example
URLs include `https://michi.example.com` and `http://100.64.0.10:3000`.

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

## Network security

Do not expose the plain HTTP port directly to the public internet. Prefer one
of these:

- Michi's built-in SSH tunnel with the remote Backend bound to loopback;
- Tailscale/WireGuard/private VPC networking;
- an HTTPS reverse proxy with firewall rules.

Rotate `MICHI_REMOTE_TOKEN` if it is disclosed. Updating the token requires
editing the saved connection in Settings. The remote SQLite database and agent
processes remain entirely on the server.
