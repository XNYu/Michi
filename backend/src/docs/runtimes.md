# Choose and configure a runtime

Applies to: registered ordinary-chat runtimes on the selected backend. Source checked: 2026-10-16; Cursor, Grok and Antigravity sections 2026-10-19. Prerequisites are source/documentation reviewed; successful provider authentication must be checked on your installation.

Open Settings → Model for the backend you are using. Select a runtime, model and supported reasoning level. A new chat's composer also exposes runtime-specific choices. A model's availability depends on installed software, authentication, provider access and that backend's configuration.

## Choose a starting point

| Need | Starting point |
| --- | --- |
| Existing Kiro CLI workflow | Kiro, with its installed engine/version |
| Crew Memory and official Crew backend | Crew, after the complete App setup |
| Direct multi-provider API use without an agent CLI | Pi |
| Claude Code's native tools/session | Claude CLI integration |
| Codex's app-server session/sandbox | Codex integration |
| Cursor's agent with an existing Cursor login or API key | Cursor CLI integration |
| xAI's official Grok CLI | Grok CLI integration |
| Google's Antigravity CLI (`agy`) | Antigravity, a smaller integration without Michi tools |

Use `runtime-capabilities` for the detailed comparison; its matrix covers Kiro CLI, Crew, Pi, Claude and Codex, and the Cursor, Grok and Antigravity sections below summarize those integrations. Changing the Settings default Runtime affects new chats; existing chats keep their runtime. Native provider features may not all be exposed in Michi.

## Kiro CLI

Install and authenticate `kiro-cli`, or configure `KIRO_CLI_BIN`. Michi connects over ACP. Kiro engines have their own capabilities; do not assume a Crew session follows the selected Kiro CLI engine. The Kiro composer offers Ask / Trust.

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

## Codex

Install `@openai/codex` and run `codex login`, or configure `CODEX_CLI_BIN` and optionally `CODEX_HOME`. Michi uses app-server JSON-RPC. The documented minimum tested CLI version is 0.138.0; this is a tested baseline, not a claim that every newer version has been verified.

Codex supports Ask / Trust / YOLO. Ask uses a read-only sandbox with approvals; Trust permits workspace writes within the native sandbox; YOLO requests full native access.

By default, Codex has no fixed session-count limit. `MICHI_CODEX_MAX_CONCURRENT` can impose a positive limit. Unset or zero means unlimited. Idle chat sessions are released after five minutes, checked once per minute, and resume their persisted native thread on the next message. Active turns and Executor-owned Agent Runs are preserved.

## Cursor

Install the Cursor CLI (`agent`, usually `~/.local/bin/agent`) or set `CURSOR_CLI_BIN`. Michi never uses Grok's `~/.grok/bin/agent`. Authenticate with `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`, or run `agent login` once in a terminal; Michi does not start an interactive login. Michi runs `agent acp` and attaches Michi tools over MCP.

The composer offers Cursor's ACP modes (agent, plan, ask) and Ask / Trust / YOLO. In Ask, Cursor's permission requests appear as approval cards. Trust and YOLO approve them automatically; neither changes the CLI's own sandbox. Chats resume with native session load. Branches use Michi's text context, same-turn steer is unavailable (busy messages queue for the next turn) and manual compaction is not connected. `MICHI_CURSOR_MAX_CONCURRENT` limits live sessions (default 100).

## Grok

Install the official xAI Grok CLI (`grok`) on PATH or in `~/.local/bin`, or set `GROK_CLI_BIN`. Michi checks that the binary is the xAI CLI and rejects unrelated `grok` tools. Run `grok login` once: Michi uses that cached login first, then `XAI_API_KEY` if set (the key Pi's xAI provider also uses), then the CLI's grok.com method. Michi runs `grok --no-auto-update agent stdio`; the default model is `grok-4.6`.

Grok offers Ask / Trust / YOLO with the same approval behavior as Cursor. Agent modes appear only when the CLI advertises them. Resume, branching, busy input and compaction behave as for Cursor. `MICHI_GROK_MAX_CONCURRENT` limits live sessions (default 100).

## Antigravity

Install the Antigravity CLI (`agy`), for example with `brew install --cask antigravity-cli`, and run `agy` once to sign in; or set `ANTIGRAVITY_CLI_BIN`. The minimum tested version is 1.1.1. Michi starts one `agy --print` process per turn and resumes the native conversation with `--conversation`.

AGY has no public ACP or app-server protocol, so this integration is smaller: Michi tools (including `michi_docs`), approval cards and same-turn steer are unavailable, and Ask / Trust / YOLO do not change AGY's behavior. Choose an AGY mode instead: Request review (default), Accept edits, Plan (read-only) or Sandbox (terminal sandbox restrictions). Branches use Michi's text context. Michi passes its instructions through a runtime-owned AGY agent and does not modify your workspace. The former `gemini` runtime ID is still accepted in `MICHI_ENABLED_RUNTIMES` and maps to Antigravity.

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
