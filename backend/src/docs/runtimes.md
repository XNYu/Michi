# Choose and configure a runtime

Applies to: registered ordinary-chat runtimes on the selected backend. Source checked: 2026-10-16. Prerequisites are source/documentation reviewed; successful provider authentication must be checked on your installation.

Open Settings → Model for the backend you are using. Select a runtime, model and supported reasoning level. A new chat's composer also exposes runtime-specific choices. A model's availability depends on installed software, authentication, provider access and that backend's configuration.

## Choose a starting point

| Need | Starting point |
| --- | --- |
| Existing Kiro CLI workflow | Kiro, with its installed engine/version |
| Crew Memory and official Crew backend | Crew, after the complete App setup |
| Direct multi-provider API use without an agent CLI | Pi |
| Claude Code's native tools/session | Claude CLI integration |
| Codex's app-server session/sandbox | Codex integration |

Use `runtime-capabilities` for the detailed comparison. Changing the Settings default Runtime affects new chats; existing chats keep their runtime. Native provider features may not all be exposed in Michi.

## Kiro CLI

Install and authenticate `kiro-cli`, or configure `KIRO_CLI_BIN`. Michi connects over ACP and starts the V3 engine by default; set `MICHI_KIRO_ENGINE=v2` before starting the backend to keep V2. Kiro engines have their own capabilities; do not assume a Crew session follows the selected Kiro CLI engine. The Kiro composer offers Ask / Approve for me / Trust on V3 and Ask / Trust on V2. See `permissions` for Approve for me.

Kiro V3 can preload Michi's own tool schemas; external MCP tools remain deferred. Tool exposure is independent from approval policy. If a tool is missing, confirm the runtime and tool configuration before changing permissions.

## Kiro Crew

Keep the official local Crew Gateway running and install/enable Michi Crew Runtime. Required setup includes Michi MCP and sessionApproval consent. Chats, model selection, approvals, Memory, resume and forks are used in Michi after setup. Read the `crew` document for the complete install and Sync procedure.

The factory pins Crew's own engine independently of the Kiro CLI engine. Keep the default michi-crew template for the complete integration. Other templates may lack Michi instructions or MCP access.

Crew Memory modes are Read & learn, Read only and Off. The default applies to new Crew chats; established chats keep their mode and forks inherit it. Crew App callers cannot perform same-turn steer: busy messages queue for the next turn. The adapter does not support image/audio attachments. These are integration limits, not claims that native Crew lacks those features.

## Pi

Pi calls provider APIs in-process and does not require a separate agent CLI. Configure the selected provider in Settings or through the supported environment variables.

API-key providers need credentials. Amazon Bedrock supports an AWS Profile, Bearer Token, Access Keys, or the SDK default credential chain, with a region and optional credential refresh command. Existing AWS credential environment variables take precedence over saved Bedrock configuration. Do not request secrets in chat; use the provider settings or local credential mechanism.

Pi's composer offers Ask / Trust. Unknown or external MCP tools require approval in Ask. Filesystem tools are provided by Michi.

## Claude

Install and authenticate `claude`, or configure `CLAUDE_CLI_BIN` and the relevant Anthropic, Bedrock or Vertex credentials. The CLI supplies native tools. Claude supports Ask / Trust / YOLO. YOLO uses the native bypass mode; approval policy and tool availability are separate controls.

Michi connects through the pinned Claude Agent SDK while retaining the installed
CLI's authentication and native history. Native AskUserQuestion uses Michi's
question card. `/status`, `/model`, `/context` and `/mcp` are host commands and
can initialize or restore a cold chat without sending a model prompt. Agent Run
restrictions continue to apply before tool execution, including when native
settings would automatically approve a tool.

## Codex

Install `@openai/codex` and run `codex login`, or configure `CODEX_CLI_BIN` and optionally `CODEX_HOME`. Michi uses app-server JSON-RPC. The documented minimum tested CLI version is 0.138.0; this is a tested baseline, not a claim that every newer version has been verified. 0.165.0 was verified live.

A provider that manages its own credentials, such as Amazon Bedrock, needs no `codex login`. When the Codex home has no `auth.json`, Michi asks app-server before the first conversation whether the configured provider still needs a login, and reports Codex unavailable only if it does.

The agent menu lists Codex's collaboration modes, Default and Plan. Plan explores without changing files and ends with a proposed plan, which appears in the answer. A chosen mode applies from the next message and stays until you choose another; a conversation resumed in Plan stays in Plan. Codex goals are off in Michi conversations: Codex would pursue a goal in turns it starts on its own, which Michi does not show.

Michi conversations do not run the MCP servers configured in your Codex `config.toml`: each Codex thread disables them by name and keeps only Michi's own server. If one still runs (for example a server a plugin adds), Michi logs a warning and the conversation continues. The Pages Assistant and Meta agent refuse such a session instead.

Codex supports Ask / Trust / YOLO. Ask uses a read-only sandbox with approvals; Trust permits workspace writes within the native sandbox; YOLO requests full native access.

By default, Codex has no fixed session-count limit. `MICHI_CODEX_MAX_CONCURRENT` can impose a positive limit. Unset or zero means unlimited. Idle chat sessions are released after five minutes, checked once per minute, and resume their persisted native thread on the next message. Active turns and Executor-owned Agent Runs are preserved.

## Local and remote requirements

The Electron package does not bundle agent CLIs. Install/configure the runtime on the backend machine, including a remote host when using a remote workspace. `MICHI_ENABLED_RUNTIMES` can restrict which runtimes a backend registers.

Node.js 22.19+ is the documented baseline for source installations, builds and remote launchers. Native runtime behavior, model context limits and provider authentication can differ; use the actual error and settings to diagnose a failure.

## Confirm the selection works

1. Check backend and executable/provider configuration on that machine.
2. Select an available model rather than guessing an unsupported model ID.
3. Send a short prompt in a new chat and inspect the effective runtime/model and tool result.
4. If it fails, preserve the first error and use `troubleshooting` to distinguish auth, model access, rate limit and launch issues.

Terminal login does not prove a desktop app uses the same PATH/home/configuration. See `configuration` for absolute CLI overrides and credential precedence. Do not share secret values while collecting diagnostics.

Related documents: `runtime-capabilities`, `configuration`, `permissions`, `sessions-and-recovery`, `crew`.
