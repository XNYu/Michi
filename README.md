<div align="center">

# Michi

**Fork, detour, side quest, btw, branch — Michi keeps up with your non-linear mind.**

A branch-native AI workspace for divergent thinking. Explore many paths from one
conversation, run them side by side, and fold the good ones back together.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/michiworks/Michi/releases/latest)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)](#desktop-app)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20TypeScript%20%C2%B7%20SQLite-3178C6?logo=typescript&logoColor=white)](#common-commands)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)

[Features](#features) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Shortcuts](#shortcuts) · [Configuration](#configuration)


https://github.com/user-attachments/assets/9f4cd982-0371-4921-9776-79ab58295346




</div>

See the [user guide](docs/user-guide.md) for first tasks, context and branching,
Runtime comparisons, permissions, recovery, files, backups and troubleshooting.
The same public articles are available to agents through `michi_docs`.

## Highlights

- **Branching work, not disposable chats**: create manual branches, let an
  agent fan out child branches, weave selected nodes, build digests, inspect a
  thread map, and follow an append-only branch Overview journal.
- **Multiple agent runtimes**: Kiro, Kiro Crew, Cursor and Grok over ACP, Pi with multiple
  API providers, Claude Code CLI, Codex, and Antigravity. Runtime, provider,
  model, reasoning, and permission options are selected per conversation where
  the runtime supports them.
- **Durable streaming**: turns are persisted with IDs and sequence watermarks.
  Pane layouts survive reloads, historical messages load lazily, and an
  interrupted renderer can reattach to a turn that is still running.
- **Artifacts as reusable context**: save documents, files, images, and links;
  favorite or search them; import external files without copying via symlinks;
  preview supported files in a read-only pane; and mention artifacts or prior
  nodes in a prompt.
- **Native Pages**: workspace pages and child pages with a block editor,
  database views, responsive grids, per-item Sources and page-local layout
  preferences. The Pages Assistant and background Meta agent maintain content
  with revision checks and human-edit protection. The current Pages interface
  supports the local backend; remote Pages is not yet available. See the
  [Pages guide](backend/src/docs/pages-and-components.md),
  [maintenance guide](backend/src/docs/pages-maintenance.md), and
  [component design guide](backend/src/docs/page-component-design.md).
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
| **Multi-runtime** | Claude Code, Codex, Kiro-CLI, Kiro Crew, Cursor CLI, Grok CLI, Pi (multi-provider), and Antigravity, side by side in the same workspace. |

Attach files or images, add comments, quote earlier text, search messages, and
export Markdown — all locally. Open the Browser pane beside your chats;
**Settings → Browser** chooses whether links open there or in the system browser.

**Settings → Model → Permissions** configures global or per-chat approval modes.
Individual approval cards can trust one tool in the current chat or all tools for
the current runtime session. Available modes depend on the runtime. Native resume
and fork are independently configurable per runtime.

Home lists recent threads across workspaces. Separate windows retain independent
composer drafts, and a message sent during confirmed runtime cleanup continues
automatically once the previous turn releases its session.

## Chat permissions

In **Settings → Model → Permissions**, enable **Use global permissions** to
choose one mode for all ordinary chats on that Backend. Composer permission
controls are hidden while this switch is enabled. Turn it off to choose
**Ask**, **Trust**, or **YOLO** separately in each chat's Composer. Individual
choices are preserved when global control is enabled and restored when it is
disabled. New chats default to Ask; a choice made in the Home Composer applies
before the first prompt. Settings and chat choices are persisted by the Backend.
Kiro and Pi Composers offer **Ask / Trust**; Claude and Codex also offer **YOLO**.
Kiro V3, the default Kiro engine, also offers **Approve for me**.
Existing YOLO choices display as Trust on Kiro and Pi, with the same execution
behavior. The global menu retains YOLO when that Backend registers a runtime
that supports it, since the setting also controls chats using that runtime.

- **Ask** prompts before changes and tools requiring approval. Native read-only
  tools can run automatically. Pi also asks for unknown/MCP tools.
- **Trust** automatically approves tools while retaining the runtime's native
  sandbox. Codex permits workspace writes and keeps sandbox restrictions.
- **YOLO** automatically approves tools and requests full native access where
  supported. Claude uses its bypass permission mode; Codex uses full access.
  Kiro and Pi use backend auto-approval and do not acquire an additional OS
  sandbox from Michi, so Trust and YOLO have the same approval behavior there.
- **Approve for me** (Kiro V3 only) is Ask with Kiro's trust classifier added.
  Kiro allows workspace edits and read-only shell commands; its classifier
  approves routine work, blocks risky actions and sends an ordinary approval
  card when unsure. Michi seeds Kiro's `approve-for-me` policy preset when it
  opens the native session and starts Kiro V3 with
  `KIRO_TRUST_CLASSIFIER_MODE=enforce` unless that variable is already set.
  Switching into or out of it reopens the idle native session before the next
  message; if turning it off fails, the message is not sent. Other runtimes,
  Agent Runs and Meta agent sessions run this choice as Ask.

Changes apply from the next turn. Returning to Ask clears Michi's always-allow
chat grants. Approval remains enforced without a connected renderer. Local and
remote Backends each own their permission settings; cloud settings are scoped
to the authenticated owner. Agent Runs retain their separate permission policy.

Kiro Crew is the backend for Michi chats. Setup includes required Michi MCP and
`sessionApproval` consent; chats and Ask/Trust approvals are handled in Michi.
The official grant also covers user-owned Crew chats, and Crew allowlists/global
YOLO remain authoritative. Default installer users install directly from `~/.michi/crew-app`; later updates use `michi update` followed by Crew App **Sync**. Old generated sources and custom installs use the compatibility helper. Missing required setup or an outdated App blocks new work. See the
[Crew setup guide](runtime/src/adapters/crew/README.md).

## Quick Start

On macOS (Apple Silicon), download the signed DMG from the
[latest release](https://github.com/michiworks/Michi/releases/latest), open it, and
drag Michi into Applications.

Or install the desktop app from source:

```bash
curl -fsSL https://raw.githubusercontent.com/michiworks/Michi/main/install.sh | bash
```

The installer clones the repo into `~/Michi`, installs Node.js 22 locally if
needed, builds the desktop app, and installs it to `~/Applications/michi.app`.

On **Windows** (x64), open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/michiworks/Michi/main/install.ps1 | iex
```

The installer clones the repo into `%USERPROFILE%\Michi`, downloads Node.js 22
if needed, builds the NSIS installer (`.exe`), and creates a Start Menu
shortcut. Visual Studio Build Tools are recommended but not required — the
build falls back to prebuilt native binaries when possible.

For local web development (any platform), install Node.js 22 or newer, then run:

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

Michi starts without a selected runtime. First-run setup lists available runtimes
by name, without recommendations, and saves your choice. Kiro is optional; each
CLI runtime needs only its own installation/sign-in, and Pi uses provider
credentials without a separate agent CLI. Existing choices and explicit runtime
environment settings are preserved. Change your choice later in Settings.

For Pi, choose a provider and configure its credentials in Settings → Model.
Amazon Bedrock supports an AWS Profile, Bearer Token, Access Keys, or the SDK
default credential chain, plus a region and optional refresh command. Existing
AWS credential environment variables take precedence over saved configuration.
Google AI supports Low / Medium / High thinking for Gemini 4 Argon; see
[Pi Gemini Argon setup](docs/features/pi-gemini-argon.md) for output limits and pricing.

Supported runtimes:

| Runtime | Notes |
|---|---|
| **Claude Code** | Anthropic's Claude CLI. |
| **Kiro-CLI** | Kiro agent runtime. |
| **Kiro Crew** | Local official Crew Gateway with required App/MCP setup. See the [setup guide](runtime/src/adapters/crew/GETTING_STARTED.md). |
| **Codex** | Codex app-server runtime. |
| **Pi** | Multi-provider — Anthropic, Gemini, DeepSeek via API keys. [Gemini 4 Argon](docs/features/pi-gemini-argon.md) streams through Pi’s Google provider with a 32,768-token response limit, including thinking. |
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

#### Connect by host (experimental)

In the desktop app, open **New workspace → machine → Connect remote SSH…**, or
**Settings → Connections → Connect remote SSH**. Enter an SSH alias, a hostname,
or `user@hostname`, then choose **Connect**. Pasting `ssh HOST` works too.

The remote machine needs Linux, Bash, Python 3, git, curl, and tar, and SSH
must already work noninteractively. Michi uses your existing SSH config and
ssh-agent. It does not store SSH passwords or private keys. Host-key checks stay
strict. When SSH authentication fails, the app opens a sign-in terminal.

From that host, Michi:

- reads the connection token when a healthy backend is already running;
- starts an installed backend that is stopped, using its saved data directory,
  token, and port;
- offers **Install and connect** when no usable build is found. That fetches
  the public repository's `main` branch, installs the backend, shared, runtime and frontend
  workspaces, builds on the remote machine, and starts the background launcher;
- detects installed agent runtimes and preserves your selection, then lets you
  browse remote folders and create a workspace. Choose the runtime yourself when
  the remote machine has no saved choice.

**Settings → Connections** lists each machine's workspaces from that machine's
backend. If a saved SSH service is down, Michi tries to start the existing
installation again. Connection failures include **Copy diagnostics** and, when a
local runtime is ready, **Ask local agent**.

Behavior, security limits, and recovery details are in
[docs/remote-backend.md](docs/remote-backend.md).

#### Manual launch

On the remote machine, you can still install, build, generate a token, and
launch the Backend in the background yourself:

```bash
npm run remote:launch
# Or register an auto-restarting systemd user service instead:
npm run remote:launch -- --service
```

`remote:launch` runs the remote-safe setup, which installs only the `backend`
and `shared` workspaces. It skips
Electron-only root dependencies such as `node-pty`, so a headless Linux server
does not need Python or native build tools just to run Michi Backend. Use
Node.js 22.19 or newer.

The generated token is reused from `~/.michi/remote.env` on later runs.
The remote Backend listens on loopback by default, `remote:start` included, and
the desktop app reaches it through Michi's built-in SSH tunnel. To listen on a
network interface, set `MICHI_BIND_HOST` explicitly or pass `--public` to
`remote:launch`, and keep that port behind a firewall. Use `npm run remote:status`,
`remote:restart`, or `remote:stop` for lifecycle management. The lower-level
`remote:setup` / `remote:start` commands remain available for custom supervisors
and foreground debugging.

In the desktop app, open **Settings → Connections**, choose **SSH tunnel**, and
enter the SSH host (or `~/.ssh/config` alias), optional SSH user/port, remote
Michi port, and token. Michi uses your existing SSH config and ssh-agent; it
does not store SSH passwords or private keys. Complete the first `ssh HOST`
login and host-key confirmation in Terminal before testing the connection.
Then choose that connection when creating a workspace. Remote workspace paths
are paths on the server, for example `/home/me/project`.

Direct URLs remain supported for Tailscale/private networks and HTTPS tunnel
services. Because the remote Backend listens on loopback by default, a direct
URL needs `MICHI_BIND_HOST` set to the reachable interface's address (or
`remote:launch -- --public`), behind a firewall; a reverse proxy on the same
host can keep the loopback default. Local, direct-remote, and SSH-remote
workspaces can coexist in the same sidebar. Closing the app stops the bundled
local backend and local SSH tunnel processes only; the supervised remote
backend and already-started remote turns keep running.

Each remote connection owns its workspace and chat data. The renderer loads
that content from the connection, keeps it in memory while available, and
removes it when the connection becomes unavailable. Reconnecting fetches it
again from the remote backend. Remote content is excluded from localStorage
workspace caches and is never mirrored into the bundled Local database.
Connection settings and small UI references can still be saved locally.
Workspace, tree and node identities include their connection in the renderer, so
Local and remote entities with the same server ID remain separate. Requests
translate those identities back to the original server IDs and reject
references belonging to another connection.

[docs/remote-backend.md](docs/remote-backend.md) is the full guide and the
built-in `remote-backend` help article: requirements, token reuse, lifecycle
commands, Direct URL connections, updates, recovery and network security.

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
npm start                     # run backend/dist/server.js
npm run remote:launch         # one-command remote build + token + background start
npm run remote:launch -- --service # register/start a systemd user service
npm run remote:status         # inspect the background/service state
npm run remote:restart        # restart while preserving the token
npm run remote:stop           # stop the remote backend
npm run remote:setup          # install/build web + backend + shared + runtime (no Electron/node-pty)
npm run remote:start          # foreground remote backend on loopback, for the SSH tunnel (requires MICHI_REMOTE_TOKEN)
npm run server                # install, build artifact, then start
npm run electron:build        # package; on macOS also quit and replace the installed app
npm run electron:install      # macOS: quit Michi and replace ~/Applications/michi.app
npm run icons:generate        # rebuild .icns/.ico and web icons from assets/icons/icon.png

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
# Optional: set this only to explicitly select a runtime at startup
# MICHI_DEFAULT_RUNTIME=<runtime-id>
# Kiro engine: v3 (default) or v2
MICHI_KIRO_ENGINE=v3

# Optional CLI overrides
KIRO_CLI_BIN=/absolute/path/to/kiro-cli
CLAUDE_CLI_BIN=/absolute/path/to/claude
CODEX_CLI_BIN=/absolute/path/to/codex
MICHI_ANTIGRAVITY_BIN=/absolute/path/to/agy

# Optional hosted auth
MICHI_REQUIRE_AUTH=false

# Experimental: Custom Agents and Agent Runs (off unless exactly 1)
MICHI_CUSTOM_AGENTS=0

# Scheduled jobs (on unless 0; always off with MICHI_CLOUD=1)
MICHI_SCHEDULED_JOBS=1
# Extra renderer origins allowed to call the local API (comma-separated)
MICHI_LOCAL_CONTROL_ORIGINS=

# Diagnostics
MICHI_METRICS=0
MICHI_METRICS_RUN_ID=local-dev
MICHI_STARTUP_TRACE=0
MICHI_PERF=0
```

Pi provider keys can be saved through Settings or supplied as environment
variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DEEPSEEK_API_KEY`, and `GEMINI_API_KEY`.

Model catalogs come from three sources: the catalog pi-ai ships, the provider's
own live `/models` endpoint, and — where the provider documents one — a floating
alias. The alias decides the default, so DeepSeek defaults to `deepseek-chat`
and keeps following new DeepSeek releases without a code change, while a
provider without such an alias keeps its pinned default and relies on discovery
to surface newer ids. Discovery is best effort: it caches for ten minutes, falls
back to the last good answer, and never blocks a turn. Set
`MICHI_MODEL_DISCOVERY=0` to keep catalogs fully static and offline.

For Pi with Amazon Bedrock, configure **Settings → Model → Amazon Bedrock** or
provide AWS credentials such as `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, or
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, with `AWS_REGION`. The SDK default
chain also supports IAM roles. Local provider keys and saved Bedrock credentials
are stored in `~/.michi/config.json`; the encrypted per-user vault described
below applies to hosted API keys.

Pi uses the pinned 1.5.0 session SDK by default, including native tool transcripts
and automatic context compaction. Michi retains tool permissions, Agent Runs and
owner/workspace isolation. SDK sessions live under `MICHI_DATA_DIR/pi-sessions`;
SQLite remains authoritative, and native recovery requires a matching host history
checkpoint. Each Michi branch owns an independent SDK session. The SDK does not
load global or project Pi extensions, skills, MCP servers or auth files; Michi's
explicit MCP/skills configuration remains in effect. Unrestricted desktop
sessions also read `AGENTS.md` / `CLAUDE.md` from the working folder and its
ancestors, as the Claude and Codex runtimes do; restricted, meta-agent and
maintenance sessions and cloud mode do not. When the MCP tool definitions are
large (about 10k tokens or more), Pi declares them only after its `tool_search`
tool loads them, and the system prompt names the deferred servers.
`MICHI_PI_TOOL_SEARCH=1` always defers MCP tools, `0` never does; Agent Runs
with a tool allowlist always declare theirs. `MICHI_PI_SESSION_SDK=0`
selects the agent-core rollback engine, which has neither feature, and
invalidates its native checkpoint. Restart the backend after changing these
settings. Third-party plugins are not enabled by this integration.

Custom Agents and Agent Runs are experimental and disabled by default. They are
enabled only by starting the backend with `MICHI_CUSTOM_AGENTS=1`; there is no
Settings switch or API for it, and a `customAgents.enabled` value saved in
`config.json` by an earlier build is ignored. With the flag unset, the Agents
entry, Agent definitions, Runs, and the Agent Run tools are all unavailable;
saved definitions and Run history stay in the database. The flag is read once
at startup, so changing it takes a restart.

### Scheduled jobs and the background service

The **Scheduled** page runs a prompt in a workspace on a schedule: every N
minutes/hours/days, daily/weekdays/weekly at a time, a 5-field cron expression
with an optional IANA time zone, or once at a set time. Each run opens a new thread (or reuses one thread per
job) through the same durable turn path as a chat, so the result appears in the
sidebar and survives reloads. Jobs run with **Trust** permissions by default
because nobody is watching; choose **Ask** to have tool approvals raise a
notification instead. Missed occurrences collapse into one catch-up run, an
overlapping occurrence is skipped, runs time out after 30 minutes by default,
and a job pauses itself after 5 consecutive failures. Only one backend per data
directory schedules jobs (`scheduler_lease` in `data.db`).

Agents in a chat thread can manage the jobs of that thread's workspace with
`list_scheduled_jobs`, `create_scheduled_job`, `update_scheduled_job`,
`run_scheduled_job` and `delete_scheduled_job` (MCP for Kiro, Claude, Codex and
Crew; built-in tools for Pi). Every change except pausing asks the user to
approve that one change, and Trust/YOLO modes or "always allow" grants never
approve it. The approval shows the schedule, permission mode and prompt that
will be saved. The tools are not offered to Agent Runs and refuse to run inside
a scheduled run.

Internal integrations can opt a job into newly completed conversation turns
with `conversationUpdates: true` on the existing job API. Progress uses two
nullable columns and one mutable counter per workspace, with no separate change
log. Empty batches skip the model. The shared HTTP/tool reader supports fixed
upper bounds, counts and bounded original messages. Generic scheduled
consumption confirms explicit no-change decisions. Native
Pages maintenance has a separate managed writer that commits page/database
operations and idempotent applied/proposed receipts before advancing progress.
It uses Settings → Meta agent (Pi, Claude, Codex or Kiro; Crew is unsupported),
with startup tool-catalog checks. See the
[Pages maintenance guide](backend/src/docs/pages-maintenance.md) and
[Conversation increments](docs/features/conversation-updates.md).

Jobs only run while a backend is running. On macOS, **Settings → Background →
Keep Michi running in the background** installs a per-user LaunchAgent
(`~/Library/LaunchAgents/com.michi.backend.plist`, state in
`~/.michi/service.json`) that runs the bundled backend on the same port,
starts at login, and is restarted by launchd. Quitting or reopening the app
then leaves the backend and its turns running. The service loads `~/.michi/.env`
itself, so secrets are never written into the plist; logs go to
`~/.michi/logs/service.{out,err}.log`. After an app update the service is
restarted with the new build. Turning the setting off hands the backend back to
the app. This mode is available only in packaged macOS builds.

Finished runs send a system notification; clicking it opens Michi on the run's
thread. The app receives notices from `/api/scheduled-jobs/notifications/stream`.
When no app is connected, the background service starts Michi hidden (no window
or Dock icon) to show the notification, and that hidden instance quits after
15 idle minutes.

Web search is offered by local and desktop backends (Electron, the web
launcher, and a desktop backend reached through remote or phone access) and by
Railway, detected from Railway's injected service identifiers. Other hosted
multi-user deployments (`MICHI_CLOUD=1` outside Railway) do not offer it.
**Settings → Model → Web Search** chooses Jina Search or Tavily and saves its
key on the backend: a desktop backend keeps it in `~/.michi/config.json` with
the model-provider keys (`JINA_API_KEY` / `TAVILY_API_KEY` take precedence),
and cloud mode on Railway keeps each user's key in the encrypted per-user
vault. The UI only learns whether a key is saved. New Pi chats receive the source-aware
`web_search` tool only after a provider and key are configured. Set
`MICHI_WEB_SEARCH_ENABLED=0` to hide the configuration and tools on any
backend. `MICHI_DEFAULT_WEB_SEARCH_PROVIDER=jina` or `tavily` can select the
initial provider.
The same chats also receive `fetch_content`, which reads a public page or PDF
as text in offset-paged parts (backend/src/services/webFetch/). It refuses
non-http(s) URLs and any host that resolves to a loopback, private,
link-local, CGNAT or other reserved address, connects only to the address it
checked, re-checks every redirect, and caps redirects, size and time.

Frontend variables are declared in `frontend/src/vite-env.d.ts` and each one
is documented in `frontend/.env.example`; copy it to `frontend/.env.local` for
personal overrides. Vite inlines `VITE_*` values at build time. Restart the
dev server or rebuild after changing them.

### Development isolation

Root `dev`, `backend:dev`, and `electron:dev` commands default `MICHI_DATA_DIR`
to `~/.michi-dev`, and `MICHI_CONFIG_DIR` to the same directory unless it is
set, so a development backend does not rewrite the installed app's runtime and
model. Logs and the remaining configuration have independent paths:

| State | Default / override |
|---|---|
| SQLite databases and durable turns | `MICHI_DATA_DIR`; defaults to `~/.michi`, or `~/.michi-dev` for root dev commands. |
| Runtime/model and UI preferences | `MICHI_CONFIG_DIR/config.json`; defaults to `~/.michi/config.json`, or to the development data directory for root dev commands. |
| Saved backend connections | `MICHI_DATA_DIR/config.json`; independent of `MICHI_CONFIG_DIR`. |
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

Backend JSON configuration writes use a private temporary file and atomic
replacement, with a sibling `config.json.lock` serializing cooperating writers.
The config helper reports `CONFIG_LOCKED` after at most 250 ms waiting for a
busy writer; retry after the other writer finishes. Invalid JSON raises
`CONFIG_CORRUPT` and is preserved for repair. Read/write permission and disk failures are reported separately;
failed saves do not acknowledge success or replace the last saved file.

A crash may leave an orphan lock. For the exact configuration path in the error,
first stop **every backend using that file**. For `~/.michi/config.json`, this
includes the installed app and development backends sharing provider/Bedrock
credentials, even when their profile/data directories differ. Inspect the sibling
`config.json.lock` (`pid` and random `token` only), verify its process is no longer
running, and move that lock aside (for example,
`config.json.lock` → `config.json.lock.orphaned-20261023`). Keep `config.json`
untouched, then restart the backend and retry the save. The backend never removes
unknown locks automatically, because PID reuse and an old timestamp do not prove
that a writer is dead. Hand-edited or older clients that bypass this lock are not
covered by its concurrency guarantee.

### Hosted auth configuration

The [Dockerfile](Dockerfile) builds the frontend and bundled backend for a
Pi-only hosted deployment. Set these values in the deployment environment:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Enables secure auth cookies; use an HTTPS origin. |
| `MICHI_REQUIRE_AUTH=true` | Enables Better Auth session checks and Google sign-in. Required in cloud mode. |
| `MICHI_CLOUD=1` | Isolated multi-user hosting: owner-scoped workspaces, runtime settings, encrypted user keys and file sandboxes. The Docker image sets this and auth by default. |
| `MICHI_LOCAL_AUTH_EMAIL` | Required when auth is enabled without cloud mode: one verified email with machine-wide desktop access. Other signed-in accounts are rejected. |
| `MICHI_ADMIN_EMAILS` | Optional comma-separated verified admin emails. Empty means no admin access; applies to both authenticated modes. |
| `BETTER_AUTH_URL` | Public backend origin, for example `https://michi.example.com`. |
| `BETTER_AUTH_SECRET` | Stable random auth secret; generate with `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials. Register `<origin>/api/auth/callback/google` as an authorized redirect URI. |
| `MICHI_ENCRYPTION_KEY` | Base64-encoded 32-byte key for the per-user API-key vault; generate with `openssl rand -base64 32`. |
| `MICHI_DATA_DIR` | Persistent writable data directory, usually `/data` in a container. |
| `MICHI_CORS_ORIGINS` | Comma-separated allowed origins; configure the actual hosted origins when using auth. Without auth it also admits a UI origin that is neither the backend itself nor a Michi dev renderer (see below). |

Without auth (desktop, `npm run dev`, remote access), the backend serves only
Michi's own UI: the backend's host, `MICHI_RENDERER_URL`, and in a development
build loopback port 3001. Requests that carry any other `Origin` are refused
with 403 and logged once
([localOrigins.ts](backend/src/services/localOrigins.ts)). Allow more with
`MICHI_CORS_ORIGINS`, or every loopback port with
`MICHI_ALLOW_LOOPBACK_ORIGINS=1`. Without remote access, the backend also
refuses `Host` headers that name a DNS host other than localhost (DNS
rebinding); IP addresses pass. List a LAN host name, local proxy or tunnel in
`MICHI_ALLOWED_HOSTS`.

Keep `MICHI_ENCRYPTION_KEY` stable alongside the persistent volume. Key rotation
is not implemented; replacing or losing it makes stored user API keys
unreadable. Application data and encrypted user keys live in `data.db`, while
Better Auth uses `auth.sqlite`. Both need persistent storage. Authentication
behavior is implemented in [auth.ts](backend/src/services/auth.ts), and key
encoding/storage in [userKeys.ts](backend/src/services/userKeys.ts).

Authentication and cloud isolation are separate choices. With both flags off,
Michi retains its local desktop/origin-guard behavior. With auth on and cloud
off, set exactly one `MICHI_LOCAL_AUTH_EMAIL`: that verified account owns access
to the entire local installation, including legacy workspaces with no database
owner. Local provider keys, local runtime configuration, native Agent identity
and existing workspace directories retain their desktop behavior. This mode is
for a personal installation, and must not be used to isolate multiple users.
`MICHI_CLOUD=1` with auth off is rejected at startup. Auth on with neither cloud
isolation nor an explicit local account is also rejected before runtime startup.

When upgrading an authenticated deployment that previously omitted
`MICHI_CLOUD`, choose its intended mode explicitly. For a personal desktop,
set `MICHI_LOCAL_AUTH_EMAIL` to its owner's verified Google email. For hosted
multi-user service, set `MICHI_CLOUD=1`; new Docker images already do this.
Existing ownerless workspaces become invisible to normal cloud clients rather
than being assigned to the next person who signs in. Follow the reviewed
[owner migration procedure](docs/access-modes.md) before returning those
workspaces to users. Keep the existing data directory, auth database,
`BETTER_AUTH_SECRET` and `MICHI_ENCRYPTION_KEY`: existing per-user encrypted
keys remain readable. Shared local keys and config are not automatically copied
into user accounts; configure each user's provider/runtime settings explicitly.

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
              |-- Pi           -> full Pi session SDK + Michi tools and provider configuration
              |-- Claude       -> Agent SDK + installed Claude CLI warm pool
              |-- Codex        -> codex app-server JSON-RPC
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
runtime/src/adapters/kiro/   ACP-backed Kiro runtime
backend/src/agents/pi/       in-process multi-provider runtime
runtime/src/adapters/claude/ Claude Agent SDK runtime and CLI warm pool
runtime/src/adapters/codex/  Codex app-server client
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
agent-run, workflow-run and digest SSE bytes over one WebSocket per gateway/window. Ordinary
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

Subagents report into a roster on the assistant message that spawned them:
each entry carries the delegated task, an activity trail (tools with outputs
and narration), the result or error, and usage. Runtime adapters (Claude
Agent/Task, Kiro V2 crews and V3 subtasks, Codex collab agents, Crew) emit
roster patches; `shared/src/subagents.ts` holds the one fold used by the
durable turn projection and the renderer. The roster persists in message
metadata, and agents that outlive their turn are recorded as running in the
background and finish in a later turn.

Workflow runs (Claude Code `Workflow`, Kiro CLI workflows) never enter the
turn queue. `services/workflowRunHub.ts` folds each runtime's native workflow
events into a `WorkflowRunDtoV1` snapshot, stores it in `workflow_runs`, and
pushes it on `GET /api/workflow-runs/subscribe`. The renderer shows a card
under the launching message and a `workflow-run` pane with the step tree,
step messages, the report and the controls the runtime accepts (Claude: stop;
Kiro: pause, resume, stop, retry). Tool approvals a workflow asks for while
no chat turn is running are answered on its card or pane
(`POST /api/workflow-runs/:id/approvals/:approvalId`), not by opening a turn.
Kiro names the asking step. Claude does not say who asked, so its request
shows on every running workflow of the chat. If they all complete before it
is answered, it moves to the chat; if one that was running when it was asked
was stopped or failed, it is denied, since its asker most likely ended with
that run. Claude ends
background workflows with the CLI process, so a chat Stop, a model switch or
a switch into or out of YOLO also stops them. The composer's Stop, model and
permission controls say so (Settings notes it for global permissions), the
run records why, and an idle chat with a running workflow is not reclaimed
for capacity. The subscribe snapshot carries at most 2 MB of run JSON (UTF-8):
runs it trims are marked `partial` and the workflow pane fetches them whole.
Open runs are sent first; if even trimmed runs do not fit, finished runs are
left out from the first one that no longer fits, so the newest are kept.
Approval details are never trimmed. Kiro workflows are opt-in per user under
**Settings → Model → Workflows** and apply to chats opened or restored
afterwards (not to Agent Runs). When a Kiro workflow finishes, Kiro wakes the
launching chat and reports back in a turn of its own; Michi shows it as a
self-initiated turn once it shows something, and Stop ends it. A message (or
a queued parent continuation) that is on its way before that overtakes the
wake: it is sent at once, as Kiro itself handles a prompt during a wake, and
the wake is never shown. The workflow card keeps its result, and in both
recordings (a prompt sent before and after the wake's model request) Kiro
ended the wake and carried the report into the prompted turn. If that turn
ends without prompting, or Kiro refuses its prompt, a wake that has lost
nothing is shown after all; one that has is stopped. Once the wake is shown,
new messages wait for it; compaction is refused while a wake is open. Stop on
a message whose prompt is not out (or whose result is in) leaves the wake
running. A wake nobody shows is cancelled, and one Kiro does not end after
Stop leaves the session for recovery rather than for the next prompt. Its
frames stay out of a prompt's stream, except untagged frames (Kiro tags only
a wake's message chunks) of a wake that starts in the few frames between the
prompt's own end and the moment Michi reads its result.
Recovery does not restart a Kiro process while a workflow Michi tracks there
is running or paused, and says so; resume or stop a paused workflow from its
card to unblock it. A chat reloaded after its Kiro process
crashed keeps workflows only where Michi restores the session's identity
(local V3 chats); elsewhere they stay off until the chat's session is next
loaded, since Michi could not attribute them. Runs left open by a previous backend process
are marked interrupted; a Kiro run reopens if its workflow carries on.

Reverse proxies in front of an upgraded gateway must pass WebSocket Upgrade for
`/api/stream-transport` in addition to the existing HTTP routes. Do not silently
retry a foreground POST through another transport after it may have started.

Runtime-specific notes:

- **Kiro** multiplexes sessions through cwd-keyed ACP clients and injects Michi
  tools through per-session MCP HTTP slots.
- **Pi** runs in-process against configured providers and exposes Michi plus
  sandboxed file tools directly.
- **Claude** uses the pinned Agent SDK (`0.3.306`) with the installed Claude CLI,
  retaining its authentication, history and warm pool. Native questions use
  Michi's interaction UI; mandatory Run policy is enforced before tool execution,
  including native auto-approval. Models and permissions switch through SDK
  controls. Interrupt waits for both acknowledgment and the turn boundary, with
  process retirement when confirmation fails. Titles come from the main
  response's metadata, with a local user-message fallback.
  The CommonJS backend ships the SDK's ESM modules in `dist/claude-sdk`.
  See the [runtime documentation](runtime/README.md) for the in-repository layout.
- **Codex** speaks app-server JSON-RPC, performs auth/version preflight, resumes
  native threads, renders rich tool activity, and generates a first-turn title
  in parallel. Without `auth.json` it asks app-server (`account/read`) whether
  the configured provider still needs a login. The agent menu offers Codex's
  collaboration modes, Default and Plan; Plan explores read-only and proposes a
  plan. Codex goals are turned off in Michi threads, because Codex would pursue
  them in turns it starts itself. Each thread disables the MCP servers of the
  user's Codex config by name and keeps only Michi's; a server still running
  afterwards is logged. Restricted sessions (Pages Assistant, Meta agent) also
  make Codex refuse sub-agents and stop the turn if one starts anyway. Chat branch-overview entries use the hidden `set_branch_overview`
  tool by default; native resume and recovery refresh the metadata instructions.
  Follow-ups retain their configured sentinel/Hook experiment mode.

### Tools and permissions

Shared Michi tools include:

- built-in product help: `michi_docs` lists, searches and reads versioned, bundled
  documentation for workflows, context, runtimes, permissions, recovery, files,
  backups, configuration, privacy, experimental Agents, Crew and remote backends.
  It works offline and loads only requested content. For example, ask an agent
  "Check Michi's built-in docs and explain how approvals work." Agent Run
  definitions must include this capability when needed. Documentation describes
  the serving Backend build; it does not inspect live settings or grant access.
  The [catalog](backend/src/docs/catalog.json) selects the public Markdown files
  shipped with the Backend. Update the relevant document when changing a user
  workflow, then rebuild to refresh bundled copies. Existing Crew/remote guides
  are reused directly so their published instructions stay in sync.
- graph and history: `spawn_branches`, `list_threads`, `search_messages`,
  `read_node`;
- reusable material: `save_artifact`, `update_artifact`, `show_image`;
- open a link for the user: `open_url` follows **Settings → Browser → Open links in**.
  Requests are delivered once to a visible window in the owning workspace/tree
  and expire after 30 seconds. Agents should use it instead of OS `open` or
  `xdg-open` commands; web deployments fall back to the external browser.
- structured interaction and metadata: Ask User, title, follow-ups, and branch
  overview;
- workspace files: `read`, `ls`, `grep`, `find`, plus gated `write`, `edit`,
  and `bash` where the runtime supports them.

Ordinary chats use the backend's durable **Ask / Trust / YOLO** policy described
in [Chat permissions](#chat-permissions). Ask allows read-only workspace and
conversation lookup. Writes, edits, shell commands, and equivalent runtime
operations ask the user unless a chat-specific grant or an explicit bypass
mode applies. Agent Runs retain their separate permission policy.

### Frontend

`frontend/src/App.tsx` mounts preference, chat, auth/key, digest, and export
providers, then renders `TerminalShell`.

The main UI lives under `frontend/src/components/terminal/`:

- **Home**: large composer, first-run runtime/model setup, and recent threads.
- **Dashboard**: a horizontally scrollable strip of resizable chat, digest, and
  artifact panes.
- **Pages**: native documents and child pages, database views, Sources,
  responsive grids and layout preferences; a retained Assistant with conversation
  history and content-area fullscreen. Native media/renderers and generated
  worker components have different capabilities; see the linked Pages guides.
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
bindings, provider metadata, and drafts. Native Pages, database rows/views,
component versions, layout preferences and maintenance receipts also live in
SQLite. Conversation/portable JSON exports do not contain the complete native
Pages state; see [Data and backups](backend/src/docs/data-and-backups.md).

Startup uses a hydration barrier:

1. wait until the backend can answer;
2. load workspace/tree/node metadata without all message bodies;
3. eagerly load the active tree;
4. lazy-load other trees when opened;
5. reconnect any node that was persisted as streaming.

LocalStorage remains a scoped cache/fallback for Local workspaces and stores small per-window UI
state such as the active workspace. Durable workspace data is cleared from the
mirror after a successful backend hydration. Preferences are also persisted
through backend config storage.

Each remote connection owns its workspace and chat data. The renderer loads
that content from the connection and retains loaded history, drafts and replay
cursors in memory through temporary outages. Reconnecting reconciles metadata
and resumes the durable event feed. Removing or editing the saved connection
invalidates its cached data. Remote conversations initially load the newest 50
messages per node, with older pages available on demand; actions that need full
history load it before assembling their context or export. Remote content is excluded from localStorage
workspace caches and is never mirrored into the bundled Local database.
Connection settings and small UI references can still be saved locally.
Workspace, tree and node identities include their connection in the renderer, so
Local and remote entities with the same server ID remain separate. Requests
translate those identities back to the original server IDs and reject
references belonging to another connection.

Native agent sessions are resumed when the runtime supports it. Settings > Model
has a Native Resume switch for each supported runtime, enabled by default.
Disabling it reconstructs cold chat sessions from the persisted ancestor chain
and transcript; already-live sessions are not interrupted. Preferences are
stored independently per runtime and, in cloud mode, per user.

New ordinary branches use Kiro native rewind/fork, Codex `thread/fork`, or Claude SDK native fork
when the parent is idle, has native history, and belongs to the same runtime,
workspace, tree, and owner. Each child has its own native identity. Unsupported
or missing native history falls back to textual context; ambiguous runtime
failures are surfaced rather than silently starting over. Pi, active
parents, and custom-agent branches retain the existing context-based path.
Native Fork is independent of the Native Resume preference.
For Claude branches cut at a historical message, the backend maps that message
to its persisted native UUID and forks only through that position. Missing
positions fall back to the exact visible transcript prefix; they never inherit
later parent turns. Conversation forks do not rewind working files.
Settings > Model also has a per-runtime Native Fork switch for Kiro, Codex, and
Claude, enabled by default. Turning it off uses context-based branching for
new child sessions without changing existing branches or Native Resume.

The opt-in `backend/test/nativeForkSmoke.test.ts` exercises real Codex/Claude
history inheritance and child resume with disposable workspaces. Set
`MICHI_NATIVE_FORK_SMOKE=codex,claude` when running it; it uses the installed
CLIs' credentials and model quota. If a Claude wrapper changes its config
directory, explicitly set the same `CLAUDE_CONFIG_DIR` for the test.

`backend/test/claudeSdkLive.integration.test.ts` adds opt-in real SDK checks for
historical forks, parent restoration, native questions, Run policy and interrupt.
Set `MICHI_CLAUDE_SDK_SMOKE=1`, `CLAUDE_CLI_BIN`, and
`MICHI_CLAUDE_SDK_LIVE_CONFIG_DIR` to run it. It copies provider settings to a
disposable profile without copying user hooks, permissions, plugins or MCP
configuration. For OAuth-only profiles, provide supported credentials through
the environment or a provider helper; this probe does not copy credential files.
After `npm run backend:build`, `node scripts/verify-claude-sdk-sidecar.mjs`
checks SDK loading outside the checkout. Set `MICHI_SDK_VERIFY_ELECTRON` to an
Electron executable to check the same ESM sidecar inside ASAR without installing
or replacing an application.

#### Kiro ACP Engines

Michi launches **v3 by default** and passes the engine explicitly, so the CLI's
own default does not apply. Set `MICHI_KIRO_ENGINE=v2` before starting the
backend to keep v2. The engine is part of a chat's native binding: a chat
created under v2 cannot natively resume under v3 and is rebuilt from Michi's
transcript, and the reverse. Kiro Crew pins its own engine. Both engines were
verified with `kiro-cli 2.24.0` (v3 KAS `0.66.8`); the default switch and
Approve for me were checked against `kiro-cli 2.35.1`.

- v2 uses native `_session/steer` and `rewind` over the command RPC. Historical
  branches use stored native `logIndex` anchors, not UI message offsets.
- v3 uses `session/fork` with native message anchors, dynamic `configOptions`
  for model/effort settings, CLI-mediated authentication, and v3 usage/MCP
  notifications. Local chats in the same cwd share one ACP process and a stable
  Michi MCP connection by default. Every turn includes the current native
  SessionID in model context, and every Michi tool requires `session_id` to route
  to that chat's callbacks. Warm sessions can be handed directly to new chats;
  forked children receive their own current ID despite inherited history.
  Agent Run Attempts and cloud chats retain isolated ACP processes and tool
  profiles. See the [runtime documentation](runtime/README.md) for the adapter layout.
- Both engines support native load, permission decisions, cancellation/steer
  queue cleanup, and compaction. Stop is acknowledged by Kiro itself: the
  stopped prompt ends with stopReason `cancelled` (kiro-cli 2.35.1). The engine is part of durable session identity;
  legacy bindings are v2. Cross-engine history is never claimed as native resume.
- Native fork requires an idle, compatible parent. Historical messages created
  before native anchors were recorded fall back to Michi's textual context.
  Conversation rewind does not roll back workspace files.

Real CLI tests are opt-in and consume the installed account's model quota:

```bash
cd backend
MICHI_KIRO_SMOKE=v2,v3 node --require ts-node/register --require ./test/helpers/isolateUserDirs.cjs \
  --test --test-timeout=420000 test/kiroDualEngineSmoke.test.ts
```

After `npm run build`, run `MICHI_KIRO_UI_SMOKE=v2 node backend/scripts/kiro-ui-smoke.mjs`
from the repository root (repeat with `v3`). This starts a real disposable backend,
drives the production UI in Chromium, waits for durable turn completion, asserts
native fork, same-turn steering, completed compaction, and history recall after
refresh, and captures desktop/mobile screenshots.
It uses temporary database/config/workspace directories, not the user's Michi
data. `MICHI_KIRO_SMOKE_OUTPUT` optionally selects an evidence directory.
See [Runtime capabilities](backend/src/docs/runtime-capabilities.md) for current
integration limits. The [historical Kiro ACP validation](docs/validation/2026-09-24-kiro-acp.md)
records the tested versions and results of earlier runs.

### Electron

`electron/main.ts`:

- fixes the GUI-launch PATH before runtime discovery;
- runs a single app instance with multiple BrowserWindows (`Cmd/Ctrl+N`);
- persists each window's size and uses a stable backend port;
- forks one bundled backend (or, with the background service enabled, starts
  or reuses the launchd service), waits for `/api/health`, and loads the
  backend-served frontend;
- relays scheduled-run notices as clickable system notifications;
- keeps background streaming unthrottled;
- provides folder/file pickers, external-file artifact linking, file reads,
  path opening, markdown save, notifications, relaunch, and log helpers through
  the preload bridge;
- opens external links in the system browser;
- supports macOS native vibrancy and optional sleep prevention;
- stops a forked backend cleanly when the app quits (the background service
  keeps running).

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
- The Codex app-server wire surface is hand-curated in
  `runtime/src/adapters/codex/codexProtocol.ts`; no generated bindings are
  checked in.
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
