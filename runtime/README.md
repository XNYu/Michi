# Michi runtime

`runtime/` is the agent runtime layer inside Michi. It keeps Kiro-CLI, Kiro
Crew, Codex and Claude Code behind one `AgentRuntime` / `AgentSession`
interface, separate from the backend's persistence and UI.

This directory remains part of the Michi repository and ships with Michi.
It is an npm workspace only to resolve local source imports and dependencies;
it is not a separately released package. Both its source manifest and any
local validation tarball are marked `private: true`. No separate npm release,
external installation procedure or independent compatibility promise is made.

Michi consumes `src/` through the workspace entries. `RUNTIME_CONTRACT_VERSION`
is an internal interface version. The host ports and adapter boundaries below
remain useful for maintaining and testing Michi.

## Runtime and host responsibilities

The package provides:

- the contract (`AgentRuntime`, `AgentSession`, the normalized events, the
  host ports and the MCP slot contract);
- the Kiro, Crew, Codex and Claude adapters (Pi stays in Michi);
- `./mcp-host`: a loopback MCP host and `createMcpSlotProvider`, the slot
  provider Michi itself runs on;
- `createDefaultHost`, an in-memory host, `createRuntimeManager` and the
  headless session driver;
- the Crew preset `createCrewRuntime` and the Claude defaults
  `claudeAdapterOptions`, `DEFAULT_CLAUDE_LIMITS` and `DEFAULT_CLAUDE_CLI_FLAGS`.

The host provides:

- its own tools, registered on the MCP host (`registerTool`,
  `registerToolSource`);
- the record of each session's native id, and its persistence for a resume
  after a restart. Of the adapters only Claude records its sessions' native
  ids itself, through `bindings.recordNativeSessionId`. For Kiro, Crew and
  Codex the host calls that method with `session.nativeSessionId` itself, as
  the example does before it releases a session; without it the binding holds
  no native id to resume. The default host keeps the ids in memory, so a host
  that resumes across restarts also overrides `bindings.nodeBinding` and
  `bindings.recordNativeSessionId` and stores them;
- its prompt text (`ports.prompt`). The default host adds none but a
  generic session-id reminder, which Kiro v3 needs for the host's tools and a
  host can replace (see [Host tools over MCP](#host-tools-over-mcp));
- sign-in and authorization of its own users, its own HTTP API and its UI.

The product tools of `AgentToolBridge` (`spawn_branches`, `save_artifact`,
`update_artifact`) are optional: an adapter offers each one only when the
bridge implements its method, so `bridge: {}` offers none.

Crew's host tools need a Michi installation. The Crew App starts its MCP relay
from `$MICHI_CREW_INSTALL_DIR/backend/dist/crewMcpHost.js`, with `~/.michi` as
the default directory. The package carries the same relay
(`dist/adapters/crew/crewMcpHost.js`), but the v1 App does not look for it
there. Without that installation Crew sessions still run, without the host's
tools.

## Host ports

`RuntimeHost` has twelve required ports and two optional members.
`createDefaultHost` fills in all of them, and a host overrides the methods it
owns (`ports`):

| Port | What it is | `createDefaultHost` |
|---|---|---|
| `config` | default models and reasoning, title models, feature flags, the data directory | the models given in its options; no title models; workflows off; `dataDir` `~/.agent-runtime`, which it does not create |
| `prompt` | prompt text the host adds, and the rendering of the context callers pass | no text but a generic `mcpSessionReminder`; context passed for the first turn and branch transcripts are dropped, with one warning per field |
| `profile` | which sessions are restricted, and the error for one an adapter refuses | restricted when the tool profile carries the restricted flag |
| `bindings` | the host's node, workspace and edge rows, native session ids, fork anchors, Crew memory modes | in memory; `recordNativeSessionId` writes there, for interactive owners only |
| `sessions` | the live session directory adapters register into | one in-memory directory, shared with `createRuntimeManager({ host })` |
| `permissions` | permission modes and grants | Ask, grants held in memory per owner and tool |
| `principal` | maps owner users onto principals | `local`, or its `principal` option; no user ownership checks |
| `observability` | logs and performance marks | the console, from `info` (its `logLevel` option); no performance output |
| `title` | whether runtimes title threads, and the instruction | off |
| `backgroundTurns` | turns a runtime starts on its own | cancelled and drained: nobody watches them |
| `workflows` | native workflow runs, controls and approvals | dropped; approvals fall back to the session |
| `backgroundSubagents` | background subagents a session still tracks | dropped |
| `interaction` (optional) | an interaction broker | absent. `@experimental`: no adapter calls it; see [Outside the v1 compatibility guarantee](#outside-the-v1-compatibility-guarantee) |
| `onSessionStateChanged` (optional) | a live session's state changed | absent; the directory logs the change |

Each adapter asserts at construction the ports it reads, and throws a
`RuntimeHostConfigError` naming every one missing:

- Claude: eleven, all twelve but `title`;
- Codex: ten, all but `backgroundTurns` and `workflows`;
- Kiro: ten, all but `workflows` and `backgroundSubagents`, and `workflows`
  too on engine v3;
- Crew: Kiro's ten and `bindings.crewMemory`.

## One host for the manager and the adapters

Pass the same host object to `createRuntimeManager({ host })` and to every
adapter, not a spread copy (`{ ...host }`). Adapters register their sessions
through `host.sessions`, and the manager reads the directory behind that port;
with two objects the manager and the adapters see different session
directories or principals, and the package cannot always tell.
`createRuntimeManager` refuses the cases it can detect.

Override `sessions` as a unit, all five of its methods: its defaults share one
in-memory directory and do not call each other through the host, so a partial
override splits registrations and lookups between two directories.

## Host tools over MCP

Adapters hand the agent the host's tools as an HTTP MCP server, one slot per
session. `createMcpHost` serves them and `createMcpSlotProvider(mcpHost)` gives
the adapters the `McpSlotProvider` they take as `mcpSlots`:

- `basePath` sets the routes: `<basePath>/<slotId>`, `<basePath>-session/<groupId>`
  and `<basePath>-hooks/<slotId>/<name>`. Crew's App relay accepts only
  `http://127.0.0.1:<port>/api/mcp/<slotId>`, so a host that runs Crew uses
  `basePath: '/api/mcp'` with `listen()`, or mounts `handler()` so that the
  slot URLs come out in that shape (`publicBaseUrl`).
- A slot with `exposedToolNames` is served those tools only, through the MCP
  host's `allowTools`. `restricted` and `isServing` are not checked by the
  provider: the host's tools read them from `ctx.slot.binding`.
- `exposedToolNames` reaches that gate through `create()` and `rebind()` only.
  Assigning it on a binding that `get()` returns changes the binding, not what
  the host serves: narrowed that way, the slot keeps serving the earlier list.
  Change it with `rebind()`.
- Use the provider only while its MCP host is open. After `mcpHost.close()`,
  `get()` still returns the bindings it held, and a `rebind()` whose patch has
  a `parentChatId` or an `exposedToolNames` key throws "MCP slot is disposed",
  after it has assigned the patch on the binding. Shut the runtimes down first,
  then close the MCP host.
- What a tool reports with `ctx.sink.emit({ type, payload })` reaches the
  session's event stream as a `host_event`, unchanged.
- Session groups (one URL for several native sessions, routed by a
  `session_id` argument) are used by Kiro v3 chat sessions only. Such a
  session learns its id from the text `prompt.mcpSessionReminder(nativeSessionId)`
  returns, which ends each of its turns. `createDefaultHost` returns a generic
  one (`[Session context: this session's id is "<id>". Pass it as session_id
  to every host tool. …]`), which `ports.prompt.mcpSessionReminder` replaces.
  A host built without `createDefaultHost` provides its own: without it the
  agent cannot name its session, and its host tool calls fail.

## Loopback requirement

`listen()` binds 127.0.0.1 only. Mounted on the host's own server through
`handler()`, the MCP routes still check every request: the peer must be a
loopback address, a request with an `Origin` header or a proxy header
(`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`) is refused, the body is
limited (4 MB by default), and only POST is accepted.

There is no credential on these routes: the 128-bit slot id in the path is the
capability. So:

- do not put a forwarding proxy in front of the MCP routes;
- run the agent processes on the host's machine;
- keep slot URLs out of logs (the MCP host logs only an id's first four
  characters).

The host's own server may bind a wider address for its own API, behind its own
sign-in; the MCP routes stay loopback-only.

## Topology

| Runtime | Processes | Host tools | MCP entry | Child environment | User directories |
|---|---|---|---|---|---|
| Kiro | one `kiro-cli` per cwd, sessions multiplexed; warm sessions per cwd | v2: one slot per session; v3 chat sessions: a session group | `michi` | `spawnEnv`, else this process's environment; with `launch`, always this process's environment | kiro-cli's own (its sessions under `~/.kiro`) |
| Crew | one Crew ACP adapter per cwd, through the Kiro Crew Gateway | the adapter writes a lease for the session's slot to `MICHI_CREW_MCP_DIR` (default `~/.michi/crew-mcp`); the App's stdio relay reads it and calls `/api/mcp/<slot>` | `michi` | always this process's environment; `spawnEnv` does not apply | `~/.michi/crew-mcp` (each lease is removed when its session ends; a small pointer file stays), and Kiro Crew's own |
| Codex | one `codex app-server` for the runtime | one slot per session | `mcp_servers.__michi_internal__` | only what `spawnEnv` returns: without it, an empty environment | `~/.codex` (`codexHome`), its sessions included |
| Claude | one `claude` process per session, and warm ones per (cwd, model) unless `limits.pool.disabled` | one slot per session, through `--mcp-config` | `__michi_internal__` | `spawnEnv` | `~/.claude` (`configDir`) |

`spawnEnv`, or the environment a child inherits, decides which credentials
the agent can see. A host process holding secrets the agent must not see
passes a filtered copy.

## Protocol contracts

Agent CLIs, the Crew App and Michi's installed files depend on these, so they
do not change with the package:

- URL shapes `/api/mcp/<slotId>` and `/api/mcp-session/<groupId>`, and Michi's
  Codex Stop-hook route `/api/codex-hooks/<slotId>/stop` (a standalone host's
  default is `<basePath>-hooks/<slotId>/stop`);
- `headers: []` in every endpoint;
- the MCP server names `michi` (Kiro, Crew) and `__michi_internal__` (Codex,
  Claude);
- Crew's relay takes only `http://127.0.0.1:<port>/api/mcp/<slotId>` with no
  headers;
- the file names `crewAcp.js`, `crewMcp.js`, `crewMcpHost.js` and
  `crew-node.json`, and `CREW_MCP_HANDLER_API = 1`;
- the App name `michi-crew-runtime`, the lease directory default
  `~/.michi/crew-mcp`, and the relay's tools `michi_list_tools` and
  `michi_call_tool`;
- the shapes of the four persistence records (`HostNodeRecord`,
  `HostWorkspaceRecord`, `HostEdgeRecord`, `RuntimeResumeBinding`), which keep
  Michi's column names.

## Environment and defaults

In this process the adapters read the environment only to find their CLIs
and start them: `PATH`, and on Windows `LOCALAPPDATA`, `APPDATA` and `ComSpec`.
The Crew adapter process, which inherits this process's environment, takes
its Gateway, App and lease settings from it (`CREW_GATEWAY_URL`,
`KIROCREW_PORT`, `KIROCREW_HOME`, `MICHI_CREW_APP`, `MICHI_CREW_AGENT`,
`MICHI_CREW_MEMORY_MODE`, `MICHI_CREW_MCP_DIR`). From the environment
`spawnEnv` returns, the Claude adapter reads `CLAUDE_CONFIG_DIR` when
`configDir` is not set, and checks which of its sign-in variables are set
before it starts the CLI (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GCP_PROJECT`); the Kiro adapter copies
that environment unchanged. With a `launch` override it uses the parent
environment. The host passes everything else:

| Runtime | Defaults in the package | The host must pass | Left to the host |
|---|---|---|---|
| Kiro | at most 20 `kiro-cli` processes (`processCap`), an idle one stopped after 5 min, 3 warm sessions per cwd, 100 bound sessions, `ask_user` waits 5 min, custom agents off, ACP idle timeout 180 s, `kiro-cli` looked up in its fixed locations; without `spawnEnv`, or with `launch`, the child inherits this process's environment | `host`, `bridge` | where else to look for `kiro-cli` (`kiroCli`), and every other setting |
| Crew (`createCrewRuntime`) | engine v2, id `crew`, label `Kiro Crew`, Crew's flavor, descriptor and capabilities, no sidecar titles, the bundled adapter resolved at each spawn, Crew's offline availability check | `host`, `bridge` | `crew`: where the adapter and App are (default: the bundled adapter, `~/.kiro/crew`, App `michi-crew-runtime`), a function to read it at each spawn |
| Codex | requests and initialize 30 s, approvals 5 min, titles 10 s, no concurrency cap, `codexHome` `~/.codex`, the CLI found on PATH or in its standard locations, no Stop hook | `host`, `bridge`, `mcpSlots`, and `spawnEnv`: without it the child gets an empty environment, no PATH or HOME | |
| Claude (`claudeAdapterOptions`) | `DEFAULT_CLAUDE_LIMITS` (15 processes; pool on, 2 per cwd, waits for warm; init 60 s; approvals 5 min; dispose 2 s, then 1 s after SIGKILL), `DEFAULT_CLAUDE_CLI_FLAGS` (bare off, strict MCP off, subagent text and human origin on), Stop hook off, the CLI found on PATH or in its standard locations | `host`, `spawnEnv`; then `bridge`, `mcpSlots` | `configDir`, `stderrWarning`, `restrictedToolApproval`, `hostText`, `modelCatalog` |

## Restricted sessions

A host marks a session restricted through `SessionProfilePort.isRestricted`
(by default: its tool profile carries the contract's restricted flag). Each
adapter then enforces it on its own runtime, so a restricted session can call
only the host's own tools:

- Claude runs it without built-in tools, user settings or other MCP servers,
  and allows a host tool call only when `ClaudeAdapterOptions.restrictedToolApproval`
  says so (default: deny every call).
- Codex runs it read-only and offline, with its shell, plugins and every MCP
  server but the host's turned off, and declines every approval. Under
  `createDefaultHost` such a session now runs locked down; before contract v1
  the default host refused it.
- Kiro and Crew refuse it (`SessionProfilePort.unsupportedError`).

Which of the host's tools a restricted session can call is for the host's
slot to enforce. When the tool profile lists `allowedToolNames`, Claude and
Codex both pass that list to the session's slot as `McpSlot.exposedToolNames`,
and the host's `McpSlotProvider` must serve that slot those tools and no
others. `createMcpSlotProvider` does: it serves a slot only its
`exposedToolNames`, after a `rebind()` too. Codex has no counterpart to
`restrictedToolApproval`, so the slot is its only check. With the adapters'
defaults this means: a restricted Claude session can call none of the host's
tools, while a restricted Codex session can call every tool its slot serves.
A host that restricts sessions should serve their slots only
`allowedToolNames`, and pass `restrictedToolApproval` for the tools a Claude
session may call.

## Capability flags and the tool bridge

`AgentRuntime.capabilities.spawnBranches` and `.saveContext` say that an
adapter can offer the host's `spawn_branches` tool and its `save_artifact` /
`update_artifact` tools. They do not say that a session gets them: the
adapters offer each tool only when the host's `AgentToolBridge` implements
its method (`spawnBranches`, `saveContext`, `updateContext`), and the flags
stay `true` when it does not. A host that leaves a method out should not read
the flag as the tool being offered.

## Implementation details

These may still change after the contract is frozen. Experimental members
are marked `@experimental` in the source, and an experimental argument or
value is described as such in its member's doc. The last two entries carry no
such mark: `CodexRuntime`'s test seams are `@internal`, and `KiroRuntime`'s
members beyond `AgentRuntime` are named here only.

- `RuntimeHost.interaction` (`InteractionBroker`): no adapter calls it yet.
- The follow-ups Stop-hook POC: `McpSlot.onValidateFollowUps`,
  `McpSlotProvider.hookEndpoint`, `McpSlotProviderOptions.hookEndpoint`,
  `CodexAdapterOptions.followUpsHook`, `ClaudeAdapterOptions.followUpsHookPoc`,
  the `followUpsHookPocInstruction` members of `ClaudeHostText` and
  `CodexHostText`, the `'hook-tool'` value of `FollowUpsExperimentMode` and
  the `hookPocEnabled` argument of `PromptPolicyPort.followUpsMetadataOutputMode`
  and `PromptPolicyPort.followUpsTurnReminder`.
- `CodexRuntime`'s test seams: an internal second constructor argument, left
  out of the published declarations.
- `KiroRuntime`'s members that `AgentRuntime` does not declare, and the types
  only they use (`KiroSession`, `KiroSessionBinding`, `OpenSessionResult`,
  `LoadSessionResult`, `McpSlotCallbacksFactory`): Michi's own wiring of Kiro.
  A host drives Kiro through `AgentRuntime` and `AgentSession`.

## Layout

- `src/contract/`: host-facing interfaces, event types and capability flags
- `src/core/`: runtime-independent session, queue and turn machinery
- `src/mcp-host/`: MCP server hosting shared by the adapters, and the reference slot provider
- `src/adapters/acp/`: the generic ACP client core, shared rather than an adapter of its own; the Kiro adapter extends it, and Crew reuses Kiro's client
- `src/adapters/{kiro,crew,codex,claude}/`: one adapter per agent backend
- `examples/`: `minimal-server-host.ts`, a host built from the public entries; not in the package
- no `testkit` entry in v1: the fakes and contract tests stay in this repository's tests

The Kiro, Crew, Codex and Claude adapters moved here from `backend/src/agents/`
as plain renames, with no shims left at their old paths; Pi stays in
`backend/src/agents/pi/`. Some core and contract modules moved earlier still
have thin re-export shims at their old backend paths, as directory indexes such
as `backend/src/agents/types/index.ts`.

## Crew App version

The Crew adapter asks for a Sync when the installed Crew App is older than
`CREW_APP_VERSION` (`src/adapters/crew/crewAppVersion.ts`). The App itself lives
outside this package, in the repository's `crew-app/`, so its version is copied
into that constant rather than imported. To release a new App version, bump
`version` in `crew-app/app.json` and `CREW_APP_VERSION` in the same commit;
`test/crewAppVersion.test.ts` fails while the two differ.

## Development and local packaging checks

Run Michi from the repository root with `npm install` and `npm run dev`.
Michi builds its runtime source into the backend bundle; a separate runtime
build is not required for application development or distribution.

The existing `build` and `pack:check` scripts remain local boundary checks.
They exercise module exports, declarations, adapter resources and the example
host in isolation. Their tarball manifest retains `private: true` and must
not be published. They do not constitute a standalone release workflow.

### Claude Agent SDK peer

The package has `@anthropic-ai/claude-agent-sdk` as an optional peer. A host
that runs the Claude adapter installs it at the version in `peerDependencies`.
`ClaudeRuntime.checkAvailability()` checks the CLI and its sign-in, not the
SDK. Without the SDK, `newSession` throws a `ClaudeSdkMissingError` (exported
by `./adapters/claude`) once those checks pass, and so do model probes and
history forks; a host that wants to tell beforehand resolves the peer itself,
as the example's `--check` does. The declarations of every entry,
`./adapters/claude` included, use none of the SDK's types, so a host
type-checks them without it.

## Tests

From the repository root:

```bash
npm test -w michi-runtime        # or: npm run test:runtime
npm run typecheck -w michi-runtime
```

`test/` holds the tests that need only this package, adapter tests included.
Tests that use Michi's host, backend code or crew-app packaging stay in
`backend/test/`; a few package-only ACP tests (acpDualEngine, acpErrors) have
not moved yet.

Tests use `node --test` through ts-node. The package depends on Michi's shared
package (`shared/` in this repository), whose entry is its built `dist/`, so
these scripts and `build` run `shared:build` first.
After pulling the commit that added this workspace, run `npm install` once from
the repository root to create the `node_modules/michi-runtime` link.
