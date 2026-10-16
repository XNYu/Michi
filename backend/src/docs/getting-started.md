# Getting started with Michi

Michi is a workspace for research and implementation across connected conversations. An agent runtime supplies the model and tools; Michi manages chats, branches, panes, artifacts and durable history.

## Install, launch and update

On macOS (Apple Silicon), use the desktop release linked from the repository README, or install from the public source:

```bash
curl -fsSL https://raw.githubusercontent.com/XNYu/Michi/main/install.sh | bash
```

The source installer uses `~/Michi` and installs the macOS application at `~/Applications/michi.app`. The default application state and configuration live under `~/.michi`; your workspace project folder is separate. A standalone desktop bundle does not include the source checkout required for Crew's portable App.

For a source checkout on supported platforms, install Node.js 22.19+ and run `npm install` followed by `npm run dev`. Open the printed frontend URL (normally `http://localhost:3001`). Configure the desired runtime on the backend machine; agent CLIs are not bundled. See the repository README for platform-specific desktop builds.

For an existing source installation, preserve local changes, pull the public `main` branch, reinstall dependencies and rebuild the desired target. On macOS `npm run electron:build` quits Michi and replaces the installed app. Development launchers and packaging can stop processes; they are not read-only diagnostics. Use `remote-backend` for remote server lifecycle instructions.

## Start a conversation

1. Open Settings → Model. Select an available runtime and a model, and complete its authentication/provider setup.
2. Create or select a workspace folder. Filesystem tools operate on the workspace's backend machine.
3. Send a message from Home. The Home Continue list reopens recent threads across workspaces.
4. Use a new chat's composer to select runtime, model and reasoning where available. Runtime-specific controls differ; consult the runtimes document.

A workspace can contain several conversation trees. The current tree and its panes determine what you are viewing; background work should not move your focus to another tree.

## Branches and reusable material

Branch or fork when you want a separate line of investigation with inherited context. The agent's `spawn_branches` tool fans out at most five child threads and should be used only when you explicitly ask to branch or split work. Agent Runs are separate durable workers, not conversation branches.

Artifacts hold reusable documents such as a spec, summary, code or links. `save_artifact` creates one and `update_artifact` replaces an existing one. They are stored as `.contexts/<name>.md` inside the workspace and can be referenced as `@name`. A file already written there does not need another redundant save call.

Agents can use `list_threads`, `search_messages`, `read_node` and `read_node_overview` to find prior conversation material. Pane tools inspect activity and read output. `send_to_thread` asks the user to approve a message to another chat.

## History, stop and reconnection

The backend saves conversation and turn state in SQLite. A renderer disconnection does not necessarily stop a durable turn. Reopen the same chat to reconnect before sending the same task again. Explicit Stop cancels the targeted turn; quitting a remote desktop connection does not stop the remote backend.

Native resume and fork capabilities depend on the runtime. Crew Memory is separate from saved chat history; turning Memory off does not delete the conversation.

## Ask Michi about Michi

Agents can call `michi_docs` to list, search and read these bundled documents. For example, ask "Check Michi's built-in docs and explain how tool approvals work." Documents are loaded on demand, work offline and describe the backend build serving the tool. They are reference material, not a report of your live settings or a grant to change them.
