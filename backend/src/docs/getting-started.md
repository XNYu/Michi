# Getting started with Michi

Applies to: ordinary chats in desktop/web, with local or connected remote backends. Source checked: 2026-10-16. Runtime availability depends on the backend installation. This is a source-reviewed guide, not a live test of your credentials.

## Install, launch and update

On macOS (Apple Silicon), use the desktop release linked from the repository README, or install from the public source:

```bash
curl -fsSL https://raw.githubusercontent.com/XNYu/Michi/main/install.sh | bash
```

The source installer uses `~/Michi` and installs the macOS application at `~/Applications/michi.app`. The default application state and configuration live under `~/.michi`; your workspace project folder is separate. A standalone desktop bundle does not include the source checkout required for Crew's portable App.

For a source checkout on supported platforms, install Node.js 22.19+ and run `npm install` followed by `npm run dev`. Open the printed frontend URL (normally `http://localhost:3001`). Configure the desired runtime on the backend machine; agent CLIs are not bundled. See the repository README for platform-specific desktop builds.

For an existing source installation, preserve local changes, pull the public `main` branch, reinstall dependencies and rebuild the desired target. On macOS `npm run electron:build` quits Michi and replaces the installed app. Development launchers and packaging can stop processes; they are not read-only diagnostics. Use `remote-backend` for remote server lifecycle instructions.

## 1. Choose where work runs

Create or select a workspace pointing to your project folder. For a remote workspace, choose the saved connection and a path that exists on that server. The backend owns chat data, runtime processes and filesystem operations for the workspace.

Use a disposable project folder while learning so that you can inspect a small file-writing exercise.

Success check: the workspace shows the intended folder and backend. A laptop path is not automatically available to a remote backend.

## 2. Connect one runtime

Open Settings → Model for the backend you are using. Choose an available runtime and model. A runtime is the agent engine; a model is the model it uses.

| Runtime | What must be ready on the backend machine |
| --- | --- |
| Kiro | `kiro-cli` installed and authenticated |
| Kiro Crew | Official local Gateway running; complete `crew`, including required Michi MCP and sessionApproval |
| Pi | Provider credentials configured; no separate agent CLI |
| Claude | Claude CLI installed and authenticated/configured |
| Codex | Codex CLI installed and authenticated/configured |
| Cursor | Cursor CLI (`agent`) installed; `agent login` or `CURSOR_API_KEY` |
| Grok | Official xAI Grok CLI installed; `grok login` or `XAI_API_KEY` |
| Antigravity | Antigravity CLI (`agy`) installed and signed in; no Michi tools or approval cards |

The desktop app does not bundle agent CLIs. A listed runtime may be unavailable, and opening Michi does not prove provider authentication works. See `runtimes` for prerequisites.

Choose Ask while learning. With Use global permissions enabled in Settings → Model → Permissions, the backend's global mode applies and per-chat permission controls are hidden. See `permissions` for each choice's scope.

## 3. Complete a first task

Send this in a new chat from Home or the workspace composer:

> Tell me the workspace directory you are using. Read the top-level filenames and explain what is here in three sentences. Do not edit files or run project scripts.

Inspect the actual tool activity. A convincing explanation alone does not establish that the agent inspected the correct directory. Compare its folder and filenames with your project.

Then try this in a disposable workspace:

> Create `michi-first-task.md` containing a short summary of this folder. Read it back and show the path. Do not change any other files.

If a permission card appears, inspect the operation and choose Allow Once. Low-risk reads can run automatically, and upstream policies can auto-approve operations. A particular prompt is not guaranteed to produce a card.

Success check: the file exists on the backend machine, its contents match the request, and the agent explains its verification. Retain any failure and find the symptom in `troubleshooting`.

## 4. Resume and branch

Reopen the same conversation from Home's Continue list or the workspace's Chats list and ask a follow-up. Michi saves history; native session restoration depends on the runtime and settings. See `sessions-and-recovery`.

Create a branch for another direction with inherited context. For example:

> Create two research branches: one for a simple implementation and one for an extensible design. Compare the findings here before editing anything.

Explicitly ask when you want split work. `spawn_branches` fans out at most five child threads. Conversation branches do not automatically isolate project files. See `concepts-and-context` and `common-workflows` before parallel implementation.

## 5. Keep useful results

Use Artifacts for reusable specs, reports, files, images and links. Ask the agent to save a summary as an Artifact, then reference its name with `@` in another prompt. Favoriting an Artifact changes its shelf ordering; it does not send the full document on every turn.

Use a thread's Export action for a Markdown transcript. A transcript is useful for reading and sharing, but is not a full restorable application backup. See `files-and-artifacts` and `data-and-backups`.

## Get help

If a chat disconnects, reopen it before repeating the task; the backend may still be working. Use Stop to request cancellation. A remote backend can continue after desktop exit; local execution ends when its backend process stops.

Ask: “Consult Michi's built-in docs and diagnose this error. Distinguish documented behavior from what you actually checked.” The agent can call `michi_docs` when available. If Michi tools are missing, open the human guide directly; a missing docs tool cannot diagnose itself.

Related documents: `help`, `runtimes`, `permissions`, `common-workflows`, `troubleshooting`.
