<div align="center">

# Michi

**Fork, detour, side quest, btw, branch — Michi keeps up with your non-linear mind.**

A branch-native AI workspace for divergent thinking. Explore many paths from one
conversation, run them side by side, and fold the good ones back together.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/XNYu/Michi/releases/latest)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)](#desktop-app)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20TypeScript%20%C2%B7%20SQLite-3178C6?logo=typescript&logoColor=white)](#common-commands)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)

[Features](#features) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Shortcuts](#shortcuts) · [Configuration](#configuration)

</div>

- **Branching work, not disposable chats**: create manual branches, let an
  agent fan out child branches, weave selected nodes, build digests, inspect a
  thread map, and follow an append-only branch Overview journal.
- **Multiple agent runtimes**: Kiro, Cursor and Grok over ACP, Pi with multiple
  API providers, Claude Code CLI, and Antigravity. Runtime, provider,
  model, reasoning, and permission options are selected per conversation where
  the runtime supports them.
- **Durable streaming**: turns are persisted with IDs and sequence watermarks.
  Pane layouts survive reloads, historical messages load lazily, and an
  interrupted renderer can reattach to a turn that is still running.
- **Artifacts as reusable context**: save documents, files, images, and links;
  favorite or search them; import external files without copying via symlinks;
  preview supported files in a read-only pane; and mention artifacts or prior
  nodes in a prompt.
- **Agent-native interaction**: reasoning, plans, tool calls, live subagent
  rosters, permission prompts, structured Ask User cards, follow-up actions,
  inline images, and runtime errors all appear in the conversation flow.
- **Coding receipts**: each turn can show which files changed and open a diff.
  User messages can be edited in place and resent from that point.
- **Fast navigation**: multi-pane dashboard, command palette, SQLite FTS
  search, back/forward history, active-thread Map and Digest views, archive,
  trash, and workspace management.
- **Desktop workflow**: multiple windows share one backend, background turns
  keep streaming, completion notifications navigate back to the right pane,
  and macOS uses native vibrancy for the glass sidebar and drawers.
- **Local-first, cloud-capable**: local and Electron modes work without auth.
  Optional Better Auth + Google OAuth, encrypted provider keys, and
  user-isolated SQLite data support hosted deployments.
- **Local + remote backends together**: bind each workspace to the bundled
  local backend or to a self-hosted Michi backend. Both kinds of session can
  stream side by side, and remote turns continue when the desktop app exits.

---

## Why Michi

Linear chat is a bad fit for a curious mind. If a single answer sparks three
questions, you either open three new chats or cram everything into one runaway
thread. Inspired by the Wikipedia rabbit hole, Michi makes **branching a
first-class primitive**: every detour becomes its own pane, persisted and
interactive, so exploring an alternative never costs you the thread you were on.

---

## Features

| | |
|---|---|
| **Branch** | Select any text in a response, add a follow-up, and spin it into a new parallel pane. Branches stream while you keep working on the parent, and the agent suggests follow-up questions to launch them. |
| **Merge / Synthesize** | Start a new node using several selected chats or panes as combined context. |
| **Digest** | Summarize an entire thread tree into one node — handy for reports, travel plans, or research write-ups. |
| **Reference** | Have one agent read another pane or a saved artifact without leaving the current chat. |
| **Branch overview** | A living Markdown file that each node updates as its branch evolves. |
| **Map** | A tree visualization of how a conversation has branched. |
| **Multi-pane** | View one, two, or three chats side by side in a single view. |
| **Artifacts** | Save files, links, code, and images; pin them to a workspace or mention them with `@`. |
| **Multi-runtime** | Claude Code, Kiro-CLI, Cursor CLI, Grok CLI, Pi (multi-provider), and Antigravity, side by side in the same workspace. |

Attach files or images, add comments, quote earlier text, search messages, and
export Markdown — all locally.

---

## Quick Start

On macOS (Apple Silicon), download the signed DMG from the
[latest release](https://github.com/XNYu/Michi/releases/latest), open it, and
drag Michi into Applications.

Or install the desktop app from source:

```bash
curl -fsSL https://raw.githubusercontent.com/XNYu/Michi/main/install.sh | bash
```

The installer clones the repo into `~/Michi`, installs Node.js 22 locally if
needed, builds the desktop app, and installs it to `~/Applications/michi.app`.

For local web development, install Node.js 22 or newer, then run:

```bash
npm install
npm run dev
```

Open `http://localhost:3001`, create a workspace, and start a thread. Michi
needs at least one agent runtime or provider — configure these from **Settings**
after the app starts. CLI-based runtimes (Kiro, Claude Code, Cursor, Grok) must be
installed and available on your `PATH`.

---

## How It Works

1. **Ask** a question in a new thread.
2. **Select** any text in the response and add a follow-up.
3. **Branch** it into a new pane — the branch streams while the parent stays put.
4. **Open extra panes** to keep related chats visible side by side.
5. **Map** the thread when it grows large.
6. **Digest** or **Merge** several chats into a smaller, combined answer.
7. **Export** Markdown to save or share the result.

Branches are treated equally: each one is persisted in the database and fully
interactive, not a throwaway side note.

---

## Runtimes & Providers

Michi is runtime-agnostic. Configure any of these from Settings:

| Runtime | Notes |
|---|---|
| **Claude Code** | Anthropic's Claude CLI. |
| **Kiro-CLI** | Kiro agent runtime. |
| **Pi** | Multi-provider — Anthropic, Gemini, DeepSeek via API keys. |
| **Antigravity** | Antigravity agent runtime. |
| **Cursor** | Cursor CLI (`~/.local/bin/agent acp` — never Grok's `~/.grok/bin/agent`). Auth via `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` or an existing `agent login` cache. Official ACP modes: agent / plan / ask. |
| **Grok** | Official xAI Grok CLI (`grok --no-auto-update agent stdio`). Prefers `grok login` cache, then `XAI_API_KEY` if set, then `grok.com`. Default model `grok-4.6`. |

Provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`DEEPSEEK_API_KEY` are read from the environment or entered in Settings.

---

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+T` | Create a new thread |
| `Cmd+Option+T` | Branch from the focused chat |
| `Cmd+M` | Open the map |
| `Ctrl+Tab` | Cycle between panes |
| `Cmd+Enter` | Send as a branch from the current chat |

---

## Desktop App

```bash
npm run electron:dev      # local backend + frontend + Electron window
npm run electron:build    # macOS arm64 .dmg in dist-electron/, then installs the app
npm run electron:install  # repeat only the install step
```

`electron:build` produces an unsigned build that installs to
`~/Applications/michi.app` on macOS. Unsigned builds may need to be opened with
right-click → **Open** the first time.

### Remote backend

On the remote machine, install, build, generate a token, and launch the Backend
in the background with one command:

```bash
npm run remote:launch
```

The command prints `MICHI_REMOTE_TOKEN=...` after the health check succeeds.
To register an auto-restarting systemd user service instead:

```bash
npm run remote:launch -- --service
```

`remote:launch` runs the remote-safe setup, which installs only the `backend`
and `shared` workspaces. It skips
Electron-only root dependencies such as `node-pty`, so a headless Linux server
does not need Python or native build tools just to run Michi Backend. Use
Node.js 22.19 or newer.

The generated token is reused from `~/.michi/remote.env` on later runs.
Loopback binding is the default when the desktop app uses Michi's built-in SSH
tunnel. Use `npm run remote:status`, `remote:restart`, or `remote:stop` for
lifecycle management. The lower-level `remote:setup` / `remote:start` commands
remain available for custom supervisors and foreground debugging.

In the desktop app, open **Settings → Connections**, choose **SSH tunnel**, and
enter the SSH host (or `~/.ssh/config` alias), optional SSH user/port, remote
Michi port, and token. Michi uses your existing SSH config and ssh-agent; it
does not store SSH passwords or private keys. Complete the first `ssh HOST`
login and host-key confirmation in Terminal before testing the connection.
Then choose that connection when creating a workspace. Remote workspace paths
are paths on the server, for example `/home/me/project`.

Direct URLs remain supported for Tailscale/private networks and HTTPS tunnel
services. Local, direct-remote, and SSH-remote workspaces can coexist in the
same sidebar. Closing the app stops the bundled local backend and local SSH
tunnel processes only; the supervised remote backend and already-started
remote turns keep running.

See [docs/remote-backend.md](docs/remote-backend.md) for deployment and
security details.

## Common Commands

Run these from the repository root unless noted.

```bash
# Development
npm run dev                   # backend (:3000) + frontend (:3001)
npm run backend:dev           # backend esbuild watch server
npm run frontend:dev          # Vite only
npm run electron:dev          # backend + frontend + Electron

# Build and package
npm run shared:build
npm run build                 # frontend build + backend typecheck/bundle
npm run build:artifact        # also copy frontend/build to backend/dist/frontend
npm start                     # run backend/dist/server.js
npm run remote:launch         # one-command remote build + token + background start
npm run remote:launch -- --service # register/start a systemd user service
npm run remote:status         # inspect the background/service state
npm run remote:restart        # restart while preserving the token
npm run remote:stop           # stop the remote backend
npm run remote:setup          # install/build only backend + shared (no Electron/node-pty)
npm run remote:start          # foreground remote backend (requires MICHI_REMOTE_TOKEN)
npm run server                # install, build artifact, then start
npm run electron:build        # unsigned macOS arm64 dmg in dist-electron/
npm run electron:install      # copy the built app into ~/Applications

# Verification
npm run test:changed -w frontend # tests affected by uncommitted Git changes
npm run test:node -w frontend # pure logic, no jsdom
npm test -w frontend          # full Vitest suite: Node + jsdom
npm test -w backend           # Node test runner through ts-node
npm run test:e2e              # Playwright
npm run test:e2e:ui           # Playwright UI
npm run test:perf             # pane benchmark tooling tests
npm run test:stream-transport # isolated Chromium: 29 streams + file/history/upload

# Diagnostics
npm run startup:analyze -- logs/metrics.jsonl
npm run metrics:analyze -- logs/metrics.jsonl
npm run perf:pane
npm run perf:compare
```

`scripts/kill-stale-dev.mjs` runs before the combined dev loops and removes
stale Michi processes tied to this checkout.

### Frontend Test Workflow

Use a focused run while editing, then the full suite before shipping:

```bash
npm test -w frontend -- src/state/chatStreamRunner.test.ts
npm run test:related -w frontend -- src/components/ui/DrawerShell.tsx
npm run test:changed -w frontend
npm run test:watch -w frontend -- src/state/chatStreamRunner.test.ts
npm run test:dom -w frontend
npm test -w frontend
npm run typecheck -w frontend
```

Paths passed to frontend scripts are relative to `frontend/`. `test:changed`
includes staged, unstaged and untracked changes; use `--changed=main` with a
valid base ref to include committed changes since that ref. Dependency-based
selection is not a substitute for the full suite: common modules/configuration
can affect many tests, and dependencies read through filesystem APIs are not
always in the import graph. Avoid piping test output through `tail`, which hides
progress until exit and can hide a failed exit code.

Vitest resolves `michi-shared` directly to `shared/src`, so frontend test
and watch commands do not need a shared build. Builds, typechecking, backend
tests and E2E retain their existing shared-build steps. `test:raw` remains an
alias for the full frontend suite.

`frontend/vitest.config.mts` separates audited `state/*.test.ts`,
`lib/*.test.ts` and chunk-policy tests into the `node` project (worker threads).
Tests using React hooks, `window.localStorage` or browser dialogs stay in the
`dom` project (jsdom/forks), along with all other tests by default. Add new
browser-dependent `.ts` tests in those logic directories to the exclusions in
that config; a `.ts` extension alone does not mean a test is DOM-free. Both
projects retain file isolation. The default pool is capped at four workers;
override with `--maxWorkers=2` on a busy machine or a suitable larger value in CI.

Keep hook input arrays, maps and sets stable across internal renders. The DOM
setup fails on React's maximum-update-depth warning because a synchronous
effect loop can block the runner's ordinary timeout. For timer-based behavior,
advance fake timers inside `act` and restore real timers after cleanup instead
of sleeping in real time.

## Configuration

Most day-to-day setup lives in the app's **Settings** page: choose an agent,
select a model, and add provider keys when needed.

For local or server-style runs, these environment variables are the ones most
people touch:

- `MICHI_ENABLED_RUNTIMES` — limit the runtimes Michi starts.
- `MICHI_DEFAULT_RUNTIME` — choose the default runtime.
- `MICHI_DATA_DIR` — choose where Michi stores its local data.
- Provider keys — `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
  `XAI_API_KEY` (Pi xai provider; also used by the Grok CLI runtime).
- Cursor CLI — `CURSOR_CLI_BIN` (defaults to `~/.local/bin/agent`; never Grok's `~/.grok/bin/agent`), `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`.
- Grok CLI — `GROK_CLI_BIN` (official xAI binary). Auth: `grok login` cache, optional `XAI_API_KEY`. Default model `grok-4.6`. Do not implement `grok -p`.

```env
# Self-hosted remote backend
MICHI_REMOTE_ACCESS=0
MICHI_REMOTE_TOKEN=
MICHI_BIND_HOST=127.0.0.1

# Runtime registry
MICHI_ENABLED_RUNTIMES=kiro,pi,claude,cursor,grok,antigravity
MICHI_DEFAULT_RUNTIME=kiro

# Diagnostics
MICHI_METRICS=0
MICHI_METRICS_RUN_ID=local-dev
MICHI_STARTUP_TRACE=0
MICHI_PERF=0
```

Pi provider keys can be saved through Settings or supplied as environment
variables such as `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and
`GEMINI_API_KEY`.

Important frontend variables:

```env
VITE_API_URL=http://localhost:3000/api
VITE_MICHI_PROFILE_PAGE=0
VITE_MICHI_METRICS=0
VITE_MICHI_METRICS_RUN_ID=local-dev
VITE_MICHI_FRAME_METRICS=0
VITE_MICHI_FRAME_METRICS_WINDOW_MS=2000
VITE_MICHI_PERF=0
```

Vite inlines `VITE_*` values at build time. Restart the dev server or rebuild
after changing them.

### Metrics and startup profiling

Michi has a lightweight metrics facade in the backend, Electron main process,
and renderer. It is disabled by default and emits JSONL rows when enabled.

```bash
MICHI_METRICS=1 \
MICHI_FRAME_METRICS=1 \
MICHI_STARTUP_TRACE=1 \
MICHI_STARTUP_RUN_ID=metrics-$(date +%H%M%S) \
npm run electron:dev 2>&1 | tee logs/metrics.jsonl
```

Analyze the result:

```bash
npm run startup:analyze -- logs/metrics.jsonl
npm run metrics:analyze -- logs/metrics.jsonl
```

The frame sampler emits aggregate FPS, maximum frame time, long-frame, and
dropped-frame measurements instead of logging every frame.

## Architecture

```text
Electron shell (optional)
        |
        v
React + Vite TerminalShell
        |
        | HTTP APIs + multiplexed SSE over WebSocket
        v
Express API + ChatHub
        |
        +-- SQLite: data.db / audit.db / optional auth.sqlite
        +-- search, artifacts, uploads, diffs, digests, persistence
        +-- per-session Michi MCP HTTP slots
        |
        `-- runtime registry
              |-- Kiro         -> kiro-cli over ACP
              |-- Pi           -> provider APIs through pi-agent-core/pi-ai
              |-- Claude       -> Claude Code CLI warm pool
              |-- Cursor/Grok  -> shared ACP client and runtime profiles
              |-- Antigravity  -> Antigravity runtime adapter
```

The `shared/` workspace owns protocol types and turn projection logic used by
both frontend and backend.

### Backend

`backend/src/server.ts` boots the application:

- loads `backend/.env` explicitly;
- opens SQLite with WAL, foreign keys, a busy timeout, and file-based
  migrations;
- injects history, permission, provider-key, workspace, and config ports into
  the runtime layer;
- registers the enabled runtime factories;
- creates the shared MCP slot registry and `ChatHub`;
- starts runtime warm-up while routes are mounted;
- mounts health/readiness, auth, chats, agents, artifacts, files, uploads,
  diffs, digests, persistence, backup, search, version, and optional admin
  routes;
- serves `frontend/build` in production;
- shuts down active sessions, runtime pools, HTTP servers, and databases on
  exit.

Core backend areas:

```text
backend/src/agents/          runtime interfaces, ChatHub, tools, permissions
backend/src/agents/kiro/     ACP-backed Kiro runtime
backend/src/agents/pi/       in-process multi-provider runtime
backend/src/agents/claude/   Claude CLI runtime and warm pool
backend/src/routes/          HTTP/SSE route layer
backend/src/services/        SQLite, MCP, config, search, export, persistence
backend/src/db/migrations/   application SQL migrations
```

### Runtime and stream model

Each runtime implements a common `AgentRuntime` / `AgentSession` interface and
emits normalized events. The route layer therefore streams a runtime-neutral
protocol containing:

- assistant chunks, thoughts, plans, and tool updates;
- titles, branch-overview entries, follow-ups, and available commands;
- spawned branches and saved/updated artifacts;
- permission and structured user-input requests;
- inline images and live subagent activity;
- context/usage summaries, heartbeats, runtime errors, and completion.

`ChatHub` stamps turns with stable node, turn, assistant, and sequence IDs,
persists authoritative turn state, and keeps a replay window for reconnecting
subscribers. Cancelling a foreground request is distinct from a renderer
disconnect: the latter can leave the agent running so another window or a
refreshed pane can continue observing it.

Gateways advertise `streamTransport: websocket-v1` in the persistence capability
probe. The renderer then carries chat, replay, background, artifact-watch,
agent-run and digest SSE bytes over one WebSocket per gateway/window. Ordinary
file, upload and history requests keep their own HTTP connections, avoiding
HTTP/1.1 connection-slot starvation. Older gateways retain the HTTP SSE fallback.

The connection uses a short-lived, single-use ticket obtained through the normal
authenticated API. Logical streams are forwarded only to allowlisted routes on
the same backend, which still enforce session and workspace ownership. Remote
streams use the existing authenticated gateway proxy, so remote execution
backends need not support WebSocket themselves. A disconnect detaches observers;
only the explicit cancel API stops a durable turn. The adapter limits each socket
to 256 simultaneous logical streams (excess opens receive 429), bounds buffers,
and times out requests waiting for headers.

Reverse proxies in front of an upgraded gateway must pass WebSocket Upgrade for
`/api/stream-transport` in addition to the existing HTTP routes. Do not silently
retry a foreground POST through another transport after it may have started.

Runtime-specific notes:

- **Kiro** multiplexes sessions through cwd-keyed ACP clients and injects Michi
  tools through per-session MCP HTTP slots.
- **Pi** runs in-process against configured providers and exposes Michi plus
  sandboxed file tools directly.
- **Claude** uses a warm CLI pool, native resume bindings, permissions, and live
  Task-subagent tracking.
- **Cursor and Grok** use the shared ACP client with runtime-specific handshake,
  authentication, model, and tool translation profiles.
- **Antigravity** retains its dedicated runtime adapter and model discovery.

### Tools and permissions

Shared Michi tools include:

- graph and history: `spawn_branches`, `list_threads`, `search_messages`,
  `read_node`;
- reusable material: `save_artifact`, `update_artifact`, `show_image`;
- structured interaction and metadata: Ask User, title, follow-ups, and branch
  overview;
- workspace files: `read`, `ls`, `grep`, `find`, plus gated `write`, `edit`,
  and `bash` where the runtime supports them.

The default policy allows read-only workspace and conversation lookup. Writes,
edits, shell commands, and equivalent runtime operations ask the user unless a
workspace grant or an explicit bypass mode applies.

### Frontend

`frontend/src/App.tsx` mounts preference, chat, auth/key, digest, and export
providers, then renders `TerminalShell`.

The main UI lives under `frontend/src/components/terminal/`:

- **Home**: large composer, first-run runtime/model setup, and recent threads.
- **Dashboard**: a horizontally scrollable strip of resizable chat, digest, and
  artifact panes.
- **Overview**: centered branch navigation backed by an append-only per-turn
  summary journal.
- **Map**: active-thread DAG navigation and selection actions.
- **Digest**: active-thread synthesis with source tracking and stale detection.
- **Artifacts drawer**: grouped documents, files, images, and links with
  search, favorites, import, and citation.
- **Workspace management**: chat/artifact/digest inventory, archived-node bulk
  actions, folder relinking, trash, and archived threads.
- **Settings**: runtime/provider/model controls, permissions, appearance,
  sidebar density/vibrancy, typography, and developer diagnostics.

The composer uses TipTap, keeps markdown structure in its draft wire format,
supports slash and mention completion, attachments, queued sends, long-paste
conversion, and Enter-to-send with Shift+Enter for markdown continuation.

Assistant rendering uses React Markdown with GFM, KaTeX, syntax highlighting,
stream-aware block projection, grouped tools, thinking/answer tiers, inline
Ask User cards, diff receipts, images, and subagent activity.

State is split across domain reducers, hydration/persistence helpers,
per-window pane state, and shared turn projection. Synchronous refs remain
intentional so a newly-created node can be streamed into before React's next
render.

### Persistence and recovery

`data.db` is the durable source of truth for workspaces, trees, nodes, edges,
messages, turns, command receipts, artifacts, permission grants, runtime
bindings, provider metadata, and drafts.

Startup uses a hydration barrier:

1. wait until the backend can answer;
2. load workspace/tree/node metadata without all message bodies;
3. eagerly load the active tree;
4. lazy-load other trees when opened;
5. reconnect any node that was persisted as streaming.

LocalStorage remains a scoped cache/fallback and stores small per-window UI
state such as the active workspace. Durable workspace data is cleared from the
mirror after a successful backend hydration. Preferences are also persisted
through backend config storage.

Native agent sessions are resumed when the runtime supports it. If an exact
native resume is unavailable, Michi can reconstruct context from the persisted
ancestor chain and transcript.

### Electron

`electron/main.ts`:

- fixes the GUI-launch PATH before runtime discovery;
- runs a single app instance with multiple BrowserWindows (`Cmd/Ctrl+N`);
- persists each window's size and uses a stable backend port;
- forks one bundled backend, waits for `/api/health`, and loads the
  backend-served frontend;
- keeps background streaming unthrottled;
- provides folder/file pickers, external-file artifact linking, file reads,
  path opening, markdown save, notifications, relaunch, and log helpers through
  the preload bridge;
- opens external links in the system browser;
- supports macOS native vibrancy and optional sleep prevention;
- stops the backend cleanly when the app quits.

Packaged builds load `~/.michi/.env` before the backend starts. Set
`preventSleep: true` in `~/.michi/config.json` to prevent application
suspension during long turns.

## Project Structure

```text
michi/
|-- backend/
|   |-- scripts/build.mjs        # typecheck + esbuild bundle + SQL copy
|   `-- src/
|       |-- agents/              # runtime registry and adapters
|       |-- db/                  # schema and migrations
|       |-- routes/              # Express/SSE endpoints
|       `-- services/            # persistence, MCP, search, config, export
|-- frontend/
|   |-- src/
|   |   |-- components/terminal/ # desktop shell, panes, pages, drawers
|   |   |-- components/          # shared markdown, dialogs, artifact UI
|   |   |-- lib/                 # client helpers
|   |   |-- services/            # API clients and SSE parser
|   |   `-- state/               # domain state, hydration, pane state
|   |-- index.html
|   `-- vite.config.mts
|-- shared/                      # shared stream types and turn projection
|-- electron/                    # Electron main, preload, startup metrics
|-- e2e/                         # Playwright fixtures and specs
|-- docs/                        # environment and deployment guides
|-- scripts/                     # dev, metrics, and performance helpers
|-- bin/michi                    # macOS/Linux launcher and updater
|-- install.sh                   # Desktop bootstrap installer (macOS/Linux)
`-- package.json                 # npm workspaces root
```

Generated outputs:

```text
shared/dist/
backend/dist/
frontend/build/
dist-electron/
node_modules/
```

## Data and Logs

Packaged/local production defaults to `~/.michi`:

- `data.db`: application state and durable turn data.
- `audit.db`: permission and activity audit history.
- `auth.sqlite`: Better Auth data when hosted auth is enabled.
- `config.json`: runtime/provider/model and user preference config.
- `.env`: optional packaged Electron environment overrides.
- `backend-port`: stable Electron backend port.
- `logs/`: backend, Electron, startup, and runtime logs.
- `workspaces/`: scratch folders created by the desktop skip-folder flow.

Root development commands default `MICHI_DATA_DIR` to `~/.michi-dev`. Override
`MICHI_DATA_DIR` and `MICHI_LOG_DIR` when you need isolated test or profiling
runs.

## Development Notes

- Install from the repository root so `frontend`, `backend`, and `shared`
  dependencies are hoisted consistently.
- Ordinary APIs use native `fetch`. Streaming callers use `fetchStream`, which
  returns a `Response`/`ReadableStream` backed by the shared WebSocket or the
  legacy HTTP SSE fallback. Keep long-lived feeds off ordinary HTTP connections.
- A new stream event must stay aligned across shared protocol types, normalized
  runtime events, SSE serialization, frontend parsing, turn projection, and
  reducers when it mutates state.
- Node IDs are Michi's public chat identity. Runtime-native session IDs are
  resumable implementation details.
- Do not use `project.chatIds[0]` as the current root. Use forest-aware helpers
  such as `activeTreeRootNodeId(project)`.
- Do not move synchronous `nodesRef` / `projectsRef` updates into effects;
  create-and-stream flows depend on immediate reads.
- Kiro ACP `session/new` MCP entries require `headers: []` even when no headers
  are needed.
- SQL migrations must be copied into the backend bundle. The existing build
  script handles this.
- The live UI is terminal-native. Do not restore the archived React Flow canvas
  or removed mobile shell without an explicit product decision.

## Data & Privacy

Michi stores workspace state on your machine (by default under `~/.michi`, where
the local backend also writes logs). Messages are sent to whichever agent
runtime or model provider you choose, so review that provider's data policy
before using it with private work.

## License

[ISC](LICENSE) © 2026 Nan Yu.
