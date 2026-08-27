<div align="center">

# Michi

**Fork, detour, side quest, btw, branch — Michi keeps up with your non-linear mind.**

A branch-native AI workspace for divergent thinking. Explore many paths from one
conversation, run them side by side, and fold the good ones back together.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/XNYu/Michi/releases/latest)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)](#desktop-app)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20TypeScript%20%C2%B7%20SQLite-3178C6?logo=typescript&logoColor=white)](#useful-commands)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)
[![Built with Codex + GPT-5.6](https://img.shields.io/badge/built%20with-Codex%20%2B%20GPT--5.6-412991?logo=openai&logoColor=white)](#built-with-codex--gpt-56)

[Features](#features) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Built With](#built-with-codex--gpt-56) · [Shortcuts](#shortcuts) · [Configuration](#configuration)

- **Branching work, not disposable chats**: create manual branches, let an
  agent fan out child branches, weave selected nodes, build digests, inspect a
  thread map, and follow an append-only branch Overview journal.
- **Four agent runtimes**: Kiro over ACP, Pi with multiple API providers,
  Claude Code CLI, and Codex app-server. Runtime, provider,
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

</div>

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
| **Multi-runtime** | Codex, Claude Code, Kiro-CLI, Cursor CLI, Grok CLI, Pi (multi-provider), and Antigravity, side by side in the same workspace. |

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
after the app starts. CLI-based runtimes (Kiro, Claude Code, Codex, Cursor, Grok) must be
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

## Built with Codex & GPT-5.6

### How Codex Was Used

Michi's core challenge is orchestrating branching conversations across multiple
AI runtimes while keeping context coherent across branches. Codex built key
parts of this infrastructure:

- **Multi-agent session management** — the streaming infrastructure and SSE
  event routing that lets Michi coordinate responses from different providers
  (GPT-5.6, Claude, Kiro) within the same workspace without losing thread state.
- **Branch-aware context threading** — the system that propagates context across
  branches (so a child branch inherits parent context but can diverge) was built
  in a single Codex session from an architecture description.
- **Playwright E2E test suite** — end-to-end tests covering the branching
  workflow, multi-pane layout, and synthesis features, generated by analyzing
  the running application.
- **Desktop app packaging** — the Electron build pipeline, including the macOS
  installer script and DMG generation, was scaffolded by Codex and refined
  iteratively.

What I designed vs. what Codex built: I made the architectural decisions —
append-only conversation logs, the branching mental model, the provider-agnostic
adapter pattern — and Codex turned those specs into working implementations at
roughly 5–10x the speed of manual coding.

### GPT-5.6 Integration

GPT-5.6 is available as a first-class provider in Michi. Select it from Settings
and use it in any thread — including branching the same question to GPT-5.6 and
another model side by side for comparison.

### Try It (for judges)

1. Install: `curl -fsSL https://raw.githubusercontent.com/XNYu/Michi/main/install.sh | bash`
2. Launch Michi and open Settings.
3. Add your `OPENAI_API_KEY` and select GPT-5.6 as the provider.
4. Create a workspace, start a thread, and ask a question.
5. Branch the thread (`Cmd+Option+T`) to compare GPT-5.6's answer with another
   provider side by side.

---

## Runtimes & Providers

Michi is runtime-agnostic. Configure any of these from Settings:

| Runtime | Notes |
|---|---|
| **Codex** | OpenAI Codex CLI, including GPT-5.6. |
| **Claude Code** | Anthropic's Claude CLI. |
| **Kiro-CLI** | Kiro agent runtime. |
| **Pi** | Multi-provider — OpenAI, Anthropic, Gemini, DeepSeek via API keys. |
| **Antigravity** | Antigravity agent runtime. |
| **Cursor** | Cursor CLI (`~/.local/bin/agent acp` — never Grok's `~/.grok/bin/agent`). Auth via `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` or an existing `agent login` cache. Official ACP modes: agent / plan / ask. |
| **Grok** | Official xAI Grok CLI (`grok --no-auto-update agent stdio`). Prefers `grok login` cache, then `XAI_API_KEY` if set, then `grok.com`. Default model `grok-4.6`. |

Provider keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
and `DEEPSEEK_API_KEY` are read from the environment or entered in Settings.

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

### Desktop installation

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/XNYu/Michi/main/install.sh | bash
```

After installation, use `michi` to launch and `michi update` to update.

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
cd frontend && npm test       # Vitest + jsdom
cd backend && npm test        # Node test runner through ts-node
npm run test:e2e              # Playwright
npm run test:e2e:ui           # Playwright UI
npm run test:perf             # pane benchmark tooling tests

# Diagnostics
npm run startup:analyze -- logs/metrics.jsonl
npm run metrics:analyze -- logs/metrics.jsonl
npm run perf:pane
npm run perf:compare
```

`scripts/kill-stale-dev.mjs` runs before the combined dev loops and removes
stale Michi processes tied to this checkout.

## Configuration

Most day-to-day setup lives in the app's **Settings** page: choose an agent,
select a model, and add provider keys when needed.

For local or server-style runs, these environment variables are the ones most
people touch:

- `MICHI_ENABLED_RUNTIMES` — limit the runtimes Michi starts.
- `MICHI_DEFAULT_RUNTIME` — choose the default runtime.
- `MICHI_DATA_DIR` — choose where Michi stores its local data.
- Provider keys — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
  `DEEPSEEK_API_KEY`, `XAI_API_KEY` (Pi xai provider; also used by the Grok CLI runtime).
- Cursor CLI — `CURSOR_CLI_BIN` (defaults to `~/.local/bin/agent`; never Grok's `~/.grok/bin/agent`), `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`.
- Grok CLI — `GROK_CLI_BIN` (official xAI binary). Auth: `grok login` cache, optional `XAI_API_KEY`. Default model `grok-4.6`. Do not implement `grok -p`.

---

## Data & Privacy

# Self-hosted remote backend
MICHI_REMOTE_ACCESS=0
MICHI_REMOTE_TOKEN=
MICHI_BIND_HOST=127.0.0.1

# Runtime registry
MICHI_ENABLED_RUNTIMES=kiro,pi,claude,codex
MICHI_DEFAULT_RUNTIME=kiro

---

## License

[ISC](LICENSE) © 2026 Nan Yu.
