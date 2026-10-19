<div align="center">

# Michi

**Fork, detour, side quest, btw, branch — Michi keeps up with your non-linear mind.**

A branch-native AI workspace for divergent thinking. Explore many paths from one
conversation, run them side by side, and fold the good ones back together.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/XNYu/Michi/releases/latest)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)](#desktop-app)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20TypeScript%20%C2%B7%20SQLite-3178C6?logo=typescript&logoColor=white)](docs/development.md)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)

[Features](#features) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Shortcuts](#shortcuts) · [Configuration](#configuration)

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
| **Extract** | Move a branch and everything under it into a new thread with **Extract as new thread** in the tree's context menu. The parent history it was cut from is copied in and marked with an *Inherited history* divider. |
| **Merge / Synthesize** | Start a new node using several selected chats or panes as combined context. |
| **Digest** | Summarize an entire thread tree into one node — handy for reports, travel plans, or research write-ups. |
| **Reference** | Have one agent read another pane or a saved artifact without leaving the current chat. |
| **Send to thread** | With your approval for each message, an agent can message another chat in the same workspace. The message starts a turn there, labeled *From &lt;thread&gt;*, and the sender can wait for the reply. |
| **Branch overview** | A living Markdown file that each node updates as its branch evolves. |
| **Map** | A tree visualization of how a conversation has branched. |
| **Multi-pane** | View one, two, or three chats side by side in a single view. |
| **Artifacts** | Save files, links, code, and images; pin them to a workspace or mention them with `@`. |
| **Steer or queue** | Send while an agent is working. Runtimes with same-turn steering, such as Kiro CLI, Pi and Codex, take the message into the running turn; others queue it for the next turn. Accepted steers stay in the transcript as *Steered* messages, placed before the reply they changed, and survive reload. |
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
| **Kiro Crew** | Local official Crew Gateway with required App/MCP setup. See the [setup guide](backend/src/agents/crew/GETTING_STARTED.md). |
| **Codex** | Codex app-server runtime. |
| **Pi** | Multi-provider — Anthropic, Gemini, DeepSeek via API keys. [Gemini 4 Argon](docs/features/pi-gemini-argon.md) supports streaming continuation. |
| **Antigravity** | Antigravity agent runtime. |
| **Cursor** | Cursor CLI (`~/.local/bin/agent acp` — never Grok's `~/.grok/bin/agent`). Auth via `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` or an existing `agent login` cache. Official ACP modes: agent / plan / ask. |
| **Grok** | Official xAI Grok CLI (`grok --no-auto-update agent stdio`). Prefers `grok login` cache, then `XAI_API_KEY` if set, then `grok.com`. Default model `grok-4.6`. |

Provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`DEEPSEEK_API_KEY` are read from the environment or entered in Settings.

---

## Agent Tools

Michi gives agents a shared set of tools. Availability depends on the runtime,
the permission mode and the deployment.

- **Product help**: `michi_docs` lists, searches and reads versioned, bundled
  documentation for workflows, context, runtimes, permissions, recovery, files,
  backups, configuration, privacy, experimental Agents, Crew and remote backends.
  It works offline and loads only requested content. For example, ask an agent
  "Check Michi's built-in docs and explain how approvals work." Agent Run
  definitions must include this capability when needed. Documentation describes
  the serving Backend build; it does not inspect live settings or grant access.
- **Graph and history**: `spawn_branches`, `list_threads`, `search_messages`,
  `read_node`, and `read_node_overview`, which reads a node's per-turn branch
  overview journal as a lighter alternative to `read_node`.
- **Panes**: `list_panes`, `inspect_pane`, `read_pane_output` and `wait_pane`
  let an agent find chats, digests, artifacts and Agent Runs in its own
  workspace, read their output, and wait for a pane to change or a turn to
  finish without polling. They are read-only and never reach another workspace
  or backend.
- **Thread messaging**: `send_to_thread` sends one message to another started
  chat in the same workspace. Every message needs your explicit, single-use
  approval in the sending chat; Trust/YOLO modes, always-allow grants and
  session trust never approve it, and Agent Runs do not receive the tool. The
  message starts a turn in the target chat, shown as *From &lt;thread&gt;*. The
  sender can use `wait_pane` and `read_pane_output` to follow the reply.
- **Reusable material**: `save_artifact`, `update_artifact`, `show_image`.
- **Links and search**: `open_url` asks Michi to open a link using your
  **Settings → Browser** preference. `web_search` is available to Pi chats on
  deployments that enable [web search](#configuration).
- **Structured interaction and metadata**: Ask User, title, follow-ups, and
  branch overview.
- **Workspace files**: `read`, `ls`, `grep`, `find`, plus gated `write`, `edit`,
  and `bash` where the runtime supports them.

The default policy allows read-only workspace and conversation lookup. Writes,
edits, shell commands, and equivalent runtime operations ask the user unless a
workspace grant or an explicit bypass mode applies.

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

Packaged builds load `~/.michi/.env` before the backend starts. Set
`preventSleep: true` in `~/.michi/config.json` to prevent application
suspension during long turns.

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
```

Pi provider keys can be saved through Settings or supplied as environment
variables such as `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and
`GEMINI_API_KEY`.

Web search is deployment-gated and disabled by default. It is exposed only on
Railway, detected from Railway's injected service identifiers. On Railway,
**Settings → Model → Web Search** lets each user choose Jina Search or Tavily
and save a server-side key. New Pi chats receive the source-aware `web_search`
tool only after a provider and key are configured. Set
`MICHI_WEB_SEARCH_ENABLED=0` to hide the configuration and tool on Railway.
`MICHI_DEFAULT_WEB_SEARCH_PROVIDER=jina` or `tavily` can select the initial
provider for operator-managed deployments.

### Hosted auth configuration

The [Dockerfile](Dockerfile) builds the frontend and bundled backend for a
Pi-only hosted deployment. Set these values in the deployment environment:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Enables secure auth cookies; use an HTTPS origin. |
| `MICHI_REQUIRE_AUTH=true` | Enables Better Auth session checks and Google sign-in. |
| `MICHI_CLOUD=1` | Enables cloud owner scoping in runtime settings and workspace operations. |
| `BETTER_AUTH_URL` | Public backend origin, for example `https://michi.example.com`. |
| `BETTER_AUTH_SECRET` | Stable random auth secret; generate with `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials. Register `<origin>/api/auth/callback/google` as an authorized redirect URI. |
| `MICHI_ENCRYPTION_KEY` | Base64-encoded 32-byte key for the per-user API-key vault; generate with `openssl rand -base64 32`. |
| `MICHI_DATA_DIR` | Persistent writable data directory, usually `/data` in a container. |
| `MICHI_CORS_ORIGINS` | Comma-separated allowed origins; configure the actual hosted origins when using auth. |

Keep `MICHI_ENCRYPTION_KEY` stable alongside the persistent volume. Key rotation
is not implemented; replacing or losing it makes stored user API keys
unreadable. Application data and encrypted user keys live in `data.db`, while
Better Auth uses `auth.sqlite`. Both need persistent storage. Authentication
behavior is implemented in [auth.ts](backend/src/services/auth.ts), and key
encoding/storage in [userKeys.ts](backend/src/services/userKeys.ts).

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
runs. See [Development isolation](docs/development.md#development-isolation).

## Development

Commands, the test workflow, development isolation, diagnostics, architecture
and project structure are in [docs/development.md](docs/development.md).
Agent-specific project guidance is in [AGENTS.md](AGENTS.md).

## Data & Privacy

Michi stores workspace state on your machine (by default under `~/.michi`, where
the local backend also writes logs). Messages are sent to whichever agent
runtime or model provider you choose, so review that provider's data policy
before using it with private work.

## License

[ISC](LICENSE) © 2026 Nan Yu.
