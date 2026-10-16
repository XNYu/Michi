# Troubleshoot Michi

Applies to: desktop/web and local/remote backends. Source checked: 2026-10-16. The entries are diagnostic paths, not proof of the cause on your machine. Use actual runtime, backend, timestamp and first failing error.

## Find your symptom

| Symptom / search phrase | Section below | Related reference |
| --- | --- | --- |
| App exits, cannot start, exit 143, port busy | Startup | `configuration` |
| Runtime unavailable, executable missing, ENOENT | CLI / authentication | `runtimes` |
| Logged in but unauthorized, expired token, 401/403 | CLI / authentication | `configuration` |
| Empty models, model not found, 429, 5xx | Models / provider errors | `runtimes` |
| Stuck, slow, always thinking, no output | Slow / waiting | `performance-and-usage` |
| Disconnected, stream 410, 409 turn_active | Stream / busy turn | `sessions-and-recovery` |
| No approval card, Trust still refused | Approvals | `permissions` |
| Missing Michi tools, docs tool missing | Tool discovery | `crew`, `custom-agents` |
| Wrong folder, file missing, broken attachment | Files / context | `files-and-artifacts` |
| Forgot a detail, @ did not read everything | Files / context | `concepts-and-context` |
| Chats disappeared, empty workspace | History / recovery | `data-and-backups` |
| Crew setup required, Sync, command changed | Crew | `crew` |
| Remote unreachable, SSH / token error | Remote connection | `remote-backend` |
| Agents page absent, Run waiting/failed | Custom Agents | `custom-agents` |

## Startup: app/backend will not start or exits

For standard macOS installation open `~/Applications/michi.app`; the public source installer checkout is normally `~/Michi`. The installed Linux web launcher normally prints port 4649; repository backend development defaults to 3000. Use the actual address, not an assumed port.

Read the first failing log before a later shutdown. Exit 143/SIGTERM records termination and alone does not identify why. Check whether a parent launcher, application exit, update or dev process requested shutdown. Keep the surrounding timestamps.

For address-in-use errors, identify which process owns the port before deciding to stop it. Do not kill unrelated processes. For source/remote Node errors, check Node.js 22.19+ and missing native/build artifacts. A failed build and a missing agent CLI are separate problems.

Updates, dev launchers and Electron packaging can stop services or replace the app. They are not read-only diagnosis commands. Do not delete databases/credentials, force-update or reinstall as an unexplained first fix.

Success check: the intended backend remains healthy at its printed URL and the app loads its existing data.

## CLI or authentication fails

Confirm which machine/user runs the backend. Desktop PATH can differ from your interactive shell. Check the installed executable/version and configure `KIRO_CLI_BIN`, `CLAUDE_CLI_BIN` or `CODEX_CLI_BIN` when necessary.

Use the runtime's supported login/configuration mechanism under that backend user. For Pi, check the selected provider, credential source and region. AWS environment credentials take precedence over saved Bedrock choices. Never paste secret values to prove a key exists.

An unavailable runtime is not repaired by Trust/YOLO. A `401` usually concerns authentication; a `403` can concern permissions/governance. Inspect the actual response and endpoint rather than assuming every authorization error is an expired login.

Success check: a small new request using the intended model succeeds under the backend's actual environment.

## Empty models or provider errors

For an empty model list, check runtime availability/authentication and whether backend configuration permits that runtime/provider. Do not invent a model ID to bypass an empty catalog.

For model-not-found or unsupported reasoning, select an advertised accessible model/effort. Installed native versions and account entitlements matter.

For `429`, inspect the provider's rate/capacity/quota error and any retry guidance. Repeated sends can worsen throttling. For `5xx`, retain the provider request/error information and retry only when it is safe to repeat the operation. A provider failure after tool execution can leave actual file/external changes.

Success check: the same intended operation works without duplicate side effects, and the source of the error is identified.

## Slow, stuck or always thinking

Check whether the model is reasoning, a tool is executing, an approval/question is waiting, input is queued or the view is disconnected. A spinner is insufficient evidence.

Compare a small fresh task at a lower supported reasoning level if appropriate. Long history, repeated instructions, Memory retrieval, tool/network latency and capacity can all contribute. Keep original-task evidence. Moving a long prompt to a system template alone does not guarantee lower latency.

Crew's default template already carries fixed instructions. Crew busy input queues for the next turn; it does not steer the current turn. See `performance-and-usage`.

## Stream 410, disconnected chat or busy 409

Reopen the original chat and restore its backend connection first. Renderer disconnection can leave the durable turn running. A stream `410` alone does not establish a failed runtime or deleted history.

A confirmed `409` with code `turn_active` means the turn is busy; Michi handles the supported same-request retry. Other conflicts/network failures are not a reason to manually resend copies. Check original task status and effects before continuing.

If activity is unclear, collect adjacent logs and IDs instead of deleting the chat. A visible answer and runtime cleanup are separate boundaries; brief normal cleanup does not require a new branch.

## Ask does not show a card, or Trust is still refused

Confirm effective global/per-chat permissions and that an actual tool request occurred. Read-only operations can be automatic. An upstream allowlist/global YOLO may already approve a request, leaving no pending request for Michi to display.

In Crew, missing sessionApproval is incomplete setup and blocks new turns. Follow `crew`, including enabled App, required consent and approved Stub / Routed command.

Trust does not install tools, supply credentials or override an upstream denial/sandbox. Consult `permissions` for grant lifetimes and revocation. An Ask User question is a separate interaction and still needs an answer.

## Missing Michi tools or michi_docs

Check runtime/template, backend connection and selected capabilities. The ordinary tool name can have a runtime namespace prefix. Tool exposure and permission mode are different controls.

Crew uses `michi_list_tools` to discover current schemas and `michi_call_tool` to invoke one. An outdated App, broker launch approval or missing caller identity requires the `crew` setup procedure. Never substitute another session ID or unrelated MCP endpoint.

Agent Runs expose only selected capabilities: include `michi_docs` in the definition when needed. An unavailable experimental feature or a denied allowlist is not repaired by guessing hidden tool names.

If the docs tool itself is missing, use the human-readable guide in the installation/source or public repository. Do not depend exclusively on the failed tool for repair.

## Wrong files, broken attachment or forgotten context

Confirm backend, workspace folder and exact path. A remote backend cannot read an arbitrary laptop path unless you upload or otherwise make the file available. Wait for attachment upload completion.

An Artifact/reference may point to a moved external file. Restore/relink the target; registering a link does not store all its bytes. A visible image thumbnail does not prove the selected Runtime received image input; Crew's adapter does not support image/audio attachments.

A node @ reference can provide a summary rather than full history. Ask for the original transcript/Artifact section and verify the resulting source citation. Favorites do not auto-inject every document. See `concepts-and-context`.

## Missing history or unexpected restore behavior

Check account/backend, workspace/tree, archived items, Trash and completed hydration. Connection failure is not an empty database. Restore soft-deleted items through Trash before retention expiry.

Markdown export is not portable JSON import; neither replaces a complete project-file backup. Imported JSON clears native bindings and can require folder relinking/authentication. Do not overwrite the current database to investigate missing history. See `data-and-backups`.

## Crew setup, Sync or missing caller identity

Use the canonical `crew` guide's exact one-time steps. Use the `crew-app` folder in your built installation checkout; standalone bundles and custom/old generated sources use the guide's preparation procedure.

After updating your installation, Sync the existing Crew App. Reload MCP Management and approve the current launch if it says `command changed`; saved Stub opt-in alone is not launch approval. Restart the Gateway when required, after finishing/stopping active work. Do not uninstall the App to update it.

Check Gateway running, App enabled, required sessionApproval, approved Stub / Routed and shared binding directory. A source-only local commit does not update an installed desktop app. Do not infer cross-platform acceptance from the macOS verification record.

## Remote backend or SSH cannot connect

Check the connection's test result, remote service status, host/port and token without exposing the token. The path belongs to the server. For SSH, complete a normal `ssh HOST` connection once so authentication/known-host setup works.

A tunnel and the remote service have different lifetimes. Reopening Michi can recreate its tunnel, but cannot start a stopped remote backend automatically. Follow `remote-backend` for lifecycle and secure network setup. Avoid switching to a public bind as a generic workaround.

## Agents missing or Run waiting/failed

Custom Agents are off unless the backend starts with `MICHI_CUSTOM_AGENTS=1`. No Settings switch enables them. Existing definitions remain stored while disabled.

For a Run, inspect its capability snapshot, effective permissions, environment, pending interactions and attempt error. Recovery/fallback is bounded and may wait after uncertain side effects. See `custom-agents`; do not bypass a worker's allowlist or repeat external actions blindly.

## Logs and a useful problem report

Production logs default under `~/.michi/logs/`; Linux launcher output can also be in `<installation>/michi.log`. Native CLIs have their own diagnostics. Development data/config/log overrides can differ; remote runtime logs are on the remote backend.

Share this small redacted report:

```text
Michi version/build and desktop/web:
OS and local/remote backend:
Runtime, engine/CLI/Gateway version, model:
Operation and minimal reproduction:
Expected result / actual result:
Timestamp with timezone:
First relevant error and adjacent redacted lines:
Chat/turn/request ID if available:
Whether a tool/action already took effect:
Checks already performed:
```

Do not attach raw config/environment files, databases, tokens or entire private transcripts. State what remains unverified. A documented capability, a mock test and a real-provider result are different evidence.

Related documents: `help`, `configuration`, `sessions-and-recovery`, `permissions`, `crew`, `remote-backend`.
