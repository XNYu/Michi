# Developing Michi

This guide covers commands, the test workflow, development isolation,
diagnostics and architecture. For features, installation and user-facing
configuration, see the [README](../README.md). Agent-specific project guidance
is in [AGENTS.md](../AGENTS.md).

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

## Development isolation

Root `dev`, `backend:dev`, and `electron:dev` commands default `MICHI_DATA_DIR`
to `~/.michi-dev`, and `MICHI_CONFIG_DIR` to the same directory unless it is
set, so a development backend does not rewrite the installed app's runtime and
model. Logs and the remaining configuration have independent paths:

| State | Default / override |
|---|---|
| SQLite databases and durable turns | `MICHI_DATA_DIR`; defaults to `~/.michi`, or `~/.michi-dev` for root dev commands. |
| Runtime/model and UI preferences | `MICHI_CONFIG_DIR/config.json`; defaults to `~/.michi/config.json`, or to the development data directory for root dev commands. |
| Local provider keys and Bedrock credentials | `~/.michi/config.json`; these modules do not use `MICHI_CONFIG_DIR`. |
| Backend and Electron logs | `MICHI_LOG_DIR`; defaults to `~/.michi/logs` independently of `MICHI_DATA_DIR`. |
| Electron dev user data | `MICHI_ELECTRON_USER_DATA_DIR`; defaults to `<dev-data-dir>/electron-<checkout-instance>`. |
| Packaged Electron `.env`, backend-port, and desktop settings | `~/.michi`; changing `MICHI_DATA_DIR` does not move them. |

For a separate development database, supported preferences, and logs:

```bash
MICHI_DATA_DIR="$HOME/.michi-dev" \
MICHI_CONFIG_DIR="$HOME/.michi-dev" \
MICHI_LOG_DIR="$HOME/.michi-dev/logs" \
npm run dev
```

Local provider-key and Bedrock writes still target the shared `~/.michi`
configuration. A disposable run that must avoid personal credentials or native
CLI history also needs a separate user/home environment and runtime-specific
credential directories.

## Diagnostics and build-time variables

Backend and Electron diagnostics are disabled by default:

```env
# Diagnostics
MICHI_METRICS=0
MICHI_METRICS_RUN_ID=local-dev
MICHI_STARTUP_TRACE=0
MICHI_PERF=0
```

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

## Metrics and startup profiling

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

The agent-facing tool list and default permission policy are in the README's
[Agent Tools](../README.md#agent-tools) section.

The `michi_docs` [catalog](../backend/src/docs/catalog.json) selects the public
Markdown files shipped with the Backend. Update the relevant document when
changing a user workflow, then rebuild to refresh bundled copies. Existing
Crew/remote guides are reused directly so their published instructions stay in
sync.

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

Native agent sessions are resumed when the runtime supports it. Settings > Model
has a Native Resume switch for each supported runtime, enabled by default.
Disabling it reconstructs cold chat sessions from the persisted ancestor chain
and transcript; already-live sessions are not interrupted. Preferences are
stored independently per runtime and, in cloud mode, per user.

New ordinary branches use Kiro native rewind/fork or Claude `--resume --fork-session`
when the parent is idle, has native history, and belongs to the same runtime,
workspace, tree, and owner. Each child has its own native identity. Unsupported
or missing native history falls back to textual context; ambiguous runtime
failures are surfaced rather than silently starting over. Pi, active
parents, and custom-agent branches retain the existing context-based path.
Native Fork is independent of the Native Resume preference.

#### Kiro ACP Engines

Michi explicitly launches **v2 by default**, even if the CLI's own default changes.
v3 is implemented but is not selected automatically and has no new UI switch.
For an isolated v3 deployment, set `MICHI_KIRO_ENGINE=v3` before starting the
backend; omitting it or setting `v2` keeps the existing engine. Both paths were
verified with the installed `kiro-cli 2.24.0` (v3 KAS `0.66.8`).

- v2 uses native `_session/steer` and `rewind` over the command RPC. Historical
  branches use stored native `logIndex` anchors, not UI message offsets.
- v3 uses `session/fork` with native message anchors, dynamic `configOptions`
  for model/effort settings, CLI-mediated authentication, and v3 usage/MCP
  notifications. Each chat/Run has an isolated ACP process so loading a child
  cannot replace its parent's MCP connection.
- Both engines support native load, permission decisions, cancellation/steer
  queue cleanup, and compaction. The engine is part of durable session identity;
  legacy bindings are v2. Cross-engine history is never claimed as native resume.
- Native fork requires an idle, compatible parent. Historical messages created
  before native anchors were recorded fall back to Michi's textual context.
  Conversation rewind does not roll back workspace files.

Real CLI tests are opt-in and consume the installed account's model quota:

```bash
cd backend
MICHI_KIRO_SMOKE=v2,v3 node --require ts-node/register --test --test-timeout=420000 test/kiroDualEngineSmoke.test.ts
```

After `npm run build`, run `MICHI_KIRO_UI_SMOKE=v2 node backend/scripts/kiro-ui-smoke.mjs`
from the repository root (repeat with `v3`). This starts a real disposable backend,
drives the production UI in Chromium, waits for durable turn completion, asserts
native fork, same-turn steering, completed compaction, and history recall after
refresh, and captures desktop/mobile screenshots.
It uses temporary database/config/workspace directories, not the user's Michi
data. `MICHI_KIRO_SMOKE_OUTPUT` optionally selects an evidence directory.
See [Kiro ACP validation](kiro-acp-validation.md) for the verified scope,
regression coverage, and remaining boundaries.

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
