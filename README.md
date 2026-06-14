# Michi

Michi is a local workspace for branching AI conversations. It helps you explore
several paths at once, compare answers, keep context organized, and turn long
sessions into summaries you can reuse or share.

## What You Can Do

- Create workspaces for projects, folders, or topics.
- Keep multiple threads inside each workspace.
- Branch from any chat when you want to explore an alternative.
- View several chats side by side in one, two, or three panes.
- Open a map to see how a conversation has branched.
- Select chats and synthesize them into a combined answer.
- Create digest nodes that summarize active threads.
- Save reusable context blocks, pin them to a workspace, or mention them with
  `@`.
- Attach files or images, add comments, quote earlier text, search messages,
  and export Markdown.
- Use the agent runtime you have configured, such as Kiro, Claude CLI, Codex,
  or Pi-backed model providers.

## Quick Start

On macOS, install the desktop app with:

```bash
curl -fsSL https://raw.githubusercontent.com/XNYu/Michi/main/install.sh | bash
```

The installer clones the repo into `~/Michi`, installs Node.js 22 locally if
needed, builds the desktop app, and installs it to `~/Applications/michi.app`.

For manual local development, install Node.js 22 or newer, then run:

```bash
npm install
npm run dev
```

Open `http://localhost:3001`, create a workspace, and start a thread.

Michi needs at least one agent runtime or provider. You can configure providers
from Settings after the app starts. CLI-based runtimes, such as Kiro or Claude
CLI, must be installed and available on your `PATH`.

## Basic Workflow

1. Create a workspace for the project or topic you want to explore.
2. Ask your first question in a new thread.
3. Branch when you want to compare a different direction.
4. Open extra panes to keep related chats visible.
5. Use Map when the thread gets large.
6. Use Digest or Synthesize to turn several chats into a smaller summary.
7. Export Markdown when you want to save or share the result.

## Helpful Shortcuts

- `Cmd+T`: create a new thread.
- `Cmd+Option+T`: create a new branch from the focused chat.
- `Cmd+M`: open the map.
- `Ctrl+Tab`: cycle between panes.
- `Cmd+Enter`: send as a branch from the current chat.

## Desktop App

For the Electron desktop app:

```bash
npm run electron:dev
npm run electron:build
```

`electron:dev` starts the local backend, frontend, and Electron window.
`electron:build` creates an unsigned macOS arm64 `.dmg` in `dist-electron/` and
then installs the built app to `~/Applications/michi.app` on macOS.
`electron:install` repeats only the install step. Unsigned builds may need to
be opened with right-click -> Open the first time.

## Useful Commands

Run these from the repository root.

```bash
npm run dev             # backend + frontend for local web development
npm run backend:dev     # backend only
npm run frontend:dev    # frontend only
npm run build           # production frontend and backend build
npm start               # run the built backend
npm run test:e2e        # Playwright end-to-end tests
```

## Configuration

Most day-to-day setup lives in the app's Settings page: choose an agent, select
a model, and add provider keys when needed.

For local or server-style runs, these environment variables are the ones most
people touch:

- `MICHI_ENABLED_RUNTIMES`: limit the runtimes Michi starts.
- `MICHI_DEFAULT_RUNTIME`: choose the default runtime.
- `MICHI_DATA_DIR`: choose where Michi stores its local data.
- Provider keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, or `DEEPSEEK_API_KEY`.

## Data And Privacy

Michi stores workspace state on your machine. Messages are sent to whichever
agent runtime or model provider you choose, so review that provider's data
policy before using it with private work.

By default, the local backend writes data and logs under `~/.michi`.
