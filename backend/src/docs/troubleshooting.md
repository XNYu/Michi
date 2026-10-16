# Troubleshoot Michi

Use the actual runtime, backend connection, error text and recent logs to diagnose a problem. Built-in docs describe this build's behavior; they do not inspect a live session, prove that credentials work, or authorize changes. Quote the relevant document ID and lines when useful.

## App or backend will not start

For a standard installation, launch Michi normally. On macOS the app is `~/Applications/michi.app`; the installation source is normally `~/.michi`. A developer checkout can be elsewhere. Do not assume the user's installation is a developer's absolute path.

For a source installation or remote backend, check Node.js 22.19+ and the exact startup error. A port conflict, authentication failure, build failure and missing runtime are different problems. Read the first failing log entry, not only a later shutdown or exit code.

On macOS, `michi update` quits and replaces the desktop app. Development launchers can stop stale dev services. Do not run updates, installer scripts, dev launchers or Electron packaging as read-only diagnostic commands. Avoid deleting databases, credentials or app state to fix an unexplained startup error.

## Chat disconnected, looks stuck or returns an expired stream

A disconnected renderer can leave a durable turn running. Reopen the same chat and allow reconnection before sending the task again. Repeating a prompt after an ambiguous connection failure can duplicate work. An expired or unavailable stream alone does not establish that the runtime failed.

Inspect the chat/pane's current activity and recent output. Use Stop when you intend to cancel the active turn. A completed visible response and runtime cleanup are separate boundaries; a busy session can still be cleaning up. Preserve the original chat and history while collecting evidence.

## Responses take too long

Identify whether the agent is reasoning, calling a slow tool, waiting for approval, retrieving memory, queued behind another turn, or disconnected. A high reasoning level and a large context can both increase latency. Try a lower supported reasoning level in a new short test if appropriate, while retaining evidence of the original task.

Crew uses the michi-crew template for fixed instructions and variable turn context. Keep the default template unless you deliberately maintain an equivalent one. Native Crew App callers cannot perform same-turn steer; busy input queues for the next turn.

## Missing Michi tools

Tool availability and permission mode are separate. Trust does not install or expose a tool. Confirm the selected runtime and template, backend connection and enabled capabilities.

In Crew, use michi_list_tools to discover the current conversation's schemas and michi_call_tool to invoke one. Missing tools, refused identity, incomplete sessionApproval or an outdated App need the `crew` setup guide. Do not substitute another session identity or an unrelated MCP endpoint.

In ordinary chats, the tool may have a runtime namespace prefix. Agent Runs expose only selected capabilities; add michi_docs to an Agent definition when that worker needs Michi help. A Run should respect its allowlist.

## Where logs and settings live

Packaged/local production defaults to `~/.michi`. Logs are under `logs/`; runtime/provider settings are in `config.json`; `data.db` holds durable application state and `audit.db` holds permission/activity history. Hosted auth can use `auth.sqlite`. Custom data/config/log environment variables can change these locations.

Root development commands default to `~/.michi-dev`. Isolate both MICHI_DATA_DIR and MICHI_CONFIG_DIR for disposable diagnostic backends. A remote workspace's runtime logs are on its backend machine, not necessarily the desktop machine.

Inspect only the relevant time range. Configuration, logs and environment files can contain credentials and private conversation content; do not paste raw files or tokens into shared output. Prefer a small redacted error excerpt, runtime/version, operation and timestamp.

## When the docs do not answer the question

State what remains unknown and inspect the relevant settings, logs or source with available tools and appropriate authorization. Do not describe an untested fix as verified, infer live provider support from a mock test, or treat these docs as newer than the installed backend. Use the `remote-backend`, `permissions`, `runtimes` or `crew` document for the corresponding workflow.
