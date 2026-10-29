# michi-runtime

Run local coding agents from your own Node service through one interface.
`michi-runtime` puts **Kiro CLI**, **Kiro Crew**, **Codex** and
**Claude Code** behind the same `AgentRuntime` / `AgentSession` contract, so a
host writes its session handling, event rendering, approvals and tools once
and can switch or mix agents without rewriting them.

It is Michi's repository-local runtime layer. The workspace remains in this
repository and is private; Michi uses its source directly.

## What it is for

Each of these agents speaks a different protocol:

| Agent | Protocol |
|---|---|
| Kiro CLI and Kiro Crew | ACP |
| Codex | JSON-RPC to `codex app-server` |
| Claude Code | the Claude Agent SDK |

Each protocol also has its own way to stream output, ask for approval, cancel,
resume, fork and reach the host's tools. A host that wants more than one agent
ends up writing that glue once per agent.

This package is that glue, written once and tested against each agent. Use it
when you build:

- a chat or IDE-like product that lets users pick their agent;
- a backend that runs agent sessions on behalf of users or jobs, with
  approvals routed to your own UI or policy;
- a batch or scheduled job that runs an agent unattended and collects a result;
- a tool server that exposes your own functions to all four agents at once.

## What it covers

- **One session contract.**
  - Open, send, steer, cancel, resume, fork and release a session through
    `AgentRuntime` / `AgentSession`, the same way for every agent.
  - `RuntimeManager` keeps track of the sessions of every registered runtime.
- **One event stream.** A turn yields the same normalized events whichever
  agent runs it:
  - text and thinking chunks, tool calls and plans;
  - permission and user-input requests and their resolutions;
  - steering, compaction and retry phases;
  - subagent activity and usage;
  - titles, warnings and `turn_end`;
  - categorized `runtime_error`s;
  - `host_event`s reported by your own tools.
- **Approvals.**
  - The permission modes are Ask, Trust and YOLO. YOLO is full access on
    Codex and Claude Code; Kiro and Crew treat it as Trust.
  - Kiro v3 adds Approve for me on top of Ask: its own trust classifier
    approves what no rule settles (`PermissionPolicyPort.approveForMe`).
  - The answer options are `allow_once`, `allow_always`, `allow_session`
    and `reject_once`.
  - The host keeps the grants and can persist them.
  - *Restricted* sessions can call only the tools you allow (Codex, Claude
    Code, and Kiro on an agent configuration the host supplies).
- **Your tools for every agent.**
  - `./mcp-host` is a loopback-only MCP host. You register your tools on it
    once, and each session reaches them through its own capability URL.
  - `createMcpSlotProvider` wires that host into the adapters.
- **Models and effort.**
  - A runtime lists its models (`listModels`) and the reasoning levels it
    accepts.
  - A session opens or resumes with a model and a level.
  - Where the agent supports it, `setModel` and `setMode` change them on an
    open session.
- **Unattended runs.** `startHeadlessSession` drives a session without a user.
  - It answers approvals and questions through your callbacks, or pauses on
    them.
  - It ends as `completed`, `waiting`, `cancelled` or `failed`.
  - It checkpoints the native session so the run can resume.
- **A host you can start with.**
  - `createDefaultHost()` gives in-memory defaults for every host port.
  - When you need durable resume, auth or your own prompts, you replace the
    individual ports (persistence, permissions, prompt policy, principal,
    observability).

**What is not included:**
- a UI, an HTTP API for your users, user authentication, or a database (the
  host owns these, through the ports);
- installing or signing in to the agent CLIs;
- Pi, which stays in Michi.

## Runtimes

| Runtime | Entry | Talks to | Process model | Needs on the machine |
|---|---|---|---|---|
| Kiro CLI | `./adapters/kiro` (`KiroRuntime`) | `kiro-cli` over ACP, engine v3 by default, or v2 | one `kiro-cli` per working directory, sessions multiplexed on it, warm sessions | `kiro-cli`, signed in |
| Kiro Crew | `./adapters/crew` (`createCrewRuntime`) | the Kiro Crew Gateway through the bundled Crew ACP adapter | one adapter process per working directory | the Kiro Crew App, installed and approved for sessions |
| Codex | `./adapters/codex` (`CodexRuntime`) | `codex app-server` over JSON-RPC | one app-server for the runtime, a thread per session | `codex`, signed in |
| Claude Code | `./adapters/claude` (`ClaudeRuntime`, `claudeAdapterOptions`) | the Claude Agent SDK and the installed Claude CLI | one CLI process per session, warm processes per (cwd, model) | `claude`, signed in, and the optional peer `@anthropic-ai/claude-agent-sdk@0.3.306` |

`./adapters/acp` holds the generic ACP client core that the Kiro adapter
extends. Use it to add another ACP agent.

## Capabilities by runtime

What each runtime supports in 1.2. A runtime reports the same facts at run
time:
- `runtime.capabilities` holds the setting flags.
- `runtime.descriptor.harness` describes each capability with:
  - an availability: `native`, `inferred`, `experimental` or `invisible`;
  - a confidence: `native`, `projected`, `unknown` or `unverifiable`.
- `runtime.descriptor.topology` covers cancel, tool delivery and titles.

A host should read these instead of hard-coding this table. Kiro v3
reports compaction, fork and steering only when every live `kiro-cli`
negotiated them.

| Capability | Kiro CLI | Kiro Crew | Codex | Claude Code |
|---|---|---|---|---|
| Steer a running turn | ✓ queued for the agent's next boundary | — the Gateway queues App input for the next turn | ✓ | ✓ in chats: joins the turn at its next tool round, or runs right after it in the same turn |
| Stop | ✓ confirmed by the agent: the prompt ends as cancelled and the session takes the next message | ✓ confirmed by the Gateway's stop record; without one, reported as sent only | ✓ confirmed by the agent | ✓ confirmed by the agent |
| Compact the context | ✓ | ✓ `/compact` on the session's idle Gateway slot; the Gateway also compacts on its own | ✓ | ✓ `/compact` between turns; automatic compaction is reported too |
| Fork a conversation | ✓ from an idle conversation | ✓ copies the Gateway transcript and replays its context | ✓ from an idle conversation | ✓ also from an earlier saved message |
| Resume a native session | ✓ | ✓ | ✓ | ✓ |
| Approval requests | ✓; v3 adds Approve for me | ✓ once the App grants session approval | ✓ | ✓ |
| Full access (YOLO) | — treated as Trust | — treated as Trust | ✓ full native access | ✓ the CLI's bypass mode |
| Restricted sessions | ✓ on the host's `restrictedAgent` configuration; refused without it | refused | ✓ read-only and offline, host tools only, no subagents | ✓ no built-in tools, host tools only |
| Agent's own sandbox | not reported | not reported | ✓ OS sandbox and approval policy | not wired: needs bubblewrap and socat on Linux |
| Subagents | experimental roster; spawn and terminate not wired | ✓ Gateway subagent events for the session's own slots; spawns are approved in the Crew dashboard | ✓ child threads streamed | ✓ native task lifecycle and forwarded child messages |
| Usage | credits and context %, no token counts | per-turn credits and context %, no token totals | tokens | per-turn tokens of the main agent; no cost, which the CLI only estimates |
| Modes | ✓ Kiro agents | ✓ Crew templates | ✓ Default / Plan | ✓ Default / Plan, in chats |
| Model choice | ✓ | ✓ | ✓ | ✓ |
| Reasoning levels | low – max | low – max | low – xhigh | low – max |
| Warm sessions | ✓ | — | — | ✓ |
| Host tools | ✓ MCP over HTTP; v3 chats share one endpoint per directory | ✓ through the App's stdio relay, which needs a Michi installation | ✓ MCP over HTTP; the user's own configured MCP servers are turned off | ✓ MCP over HTTP |
| Titles | from a side session the user turns on | from the Gateway | generated beside the first turn | — |
| Turns the agent starts itself | v3: when a workflow it launched finishes | — | — (goals are off) | ✓ when a background task completes |
| Unattended runs (`startHeadlessSession`) | ✓ steering queued natively | — | ✓ steering through `turn/steer` | ✓ allowlisted tools, steering on the next turn |

Kiro starts on engine v3 unless the host asks for v2 (`resolveKiroEngine`).
Kiro v3 also runs Kiro workflows for users who turn them on. Claude Code's
Plan mode always asks the person to approve the plan, whatever the
permission mode. For what a restricted session can call, see
[Restricted sessions](#restricted-sessions).

## Local runtime contract

`RUNTIME_CONTRACT_VERSION` is `1`. It identifies the host/adapter contract
used within Michi; it is not a standalone package release promise. The local
workspace exports `.`, `./mcp-host` and
`./adapters/{kiro,crew,codex,claude,acp}`.

Michi runs this workspace from source. Its package.json maps the root entry
to `src/index.ts`, and `internal/<module>` to `src/<module>.ts` for in-repository
wiring. Host and adapter changes should be made and validated together.
Adapters build descriptors over `UNKNOWN_HARNESS` so newly added capabilities
receive a default. Consumers should tolerate event kinds and optional fields
they do not recognize.

## In-repository example

Run `npm install` from Michi's repository root to create the workspace links
and install dependencies, including the Claude Agent SDK used by Michi.
The runtime stays in `runtime/`, with `private: true`; it needs no separate
installation or registry release. The following example illustrates the
host/adapter boundary for repository maintenance.

A host builds one host object, a loopback MCP host carrying its own tools, a
slot provider on it, and the runtime it runs:

```ts
import { createDefaultHost, createRuntimeManager, interactiveOwner, type McpSlot } from 'michi-runtime';
import { createMcpHost, createMcpSlotProvider } from 'michi-runtime/mcp-host';
import { CodexRuntime } from 'michi-runtime/adapters/codex';

const host = createDefaultHost({ principal: 'me' });
const manager = createRuntimeManager({ host });       // the same host object, not a copy
const mcpHost = createMcpHost<McpSlot>({ basePath: '/api/mcp', serverName: 'my-host' });
mcpHost.registerTool({
  name: 'lookup', description: 'Looks a thing up.', inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => ({ content: [{ type: 'text', text: `asked by ${ctx.slot.binding.nodeId}` }] }),
});
await mcpHost.listen();                                // 127.0.0.1, a free port
const codex = new CodexRuntime({
  host, bridge: {}, mcpSlots: createMcpSlotProvider(mcpHost),
  spawnEnv: () => process.env,                         // what the agent sees: filter it if this process holds secrets
});
manager.register(codex);

const session = await codex.newSession({ sessionId: 'chat-1', cwd: process.cwd(), owner: interactiveOwner('chat-1') });
for await (const event of session.send('Call the lookup tool and tell me what it says.')) {
  if (event.kind === 'chunk') process.stdout.write(event.text);
  if (event.kind === 'permission_request') {
    const deny = event.options.find((option) => option.kind === 'reject_once');
    if (deny) session.respondToPermission?.(event.requestId, deny.optionId);
  }
}
await codex.shutdown();
await mcpHost.close();
```

`examples/minimal-server-host.ts` is an in-repository maintenance example.
It exercises host tools, approval, cancellation and native resume for the four
runtimes. `pack:check` compiles and runs its `--check --runtime all` mode
without starting an agent, using the private local validation artifact
described under [Building and packing](#building-and-packing). Its head
comment documents the optional live checks, which require a configured agent.

## What the package provides, and what the host provides

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
| `permissions` | permission modes, Approve for me and grants | Ask, Approve for me off (its `approveForMe` option), grants held in memory per owner and tool |
| `principal` | maps owner users onto principals | `local`, or its `principal` option; no user ownership checks |
| `observability` | logs and performance marks | the console, from `info` (its `logLevel` option); no performance output |
| `title` | whether runtimes title threads, and the instruction | off |
| `backgroundTurns` | turns a runtime starts on its own | cancelled and drained: nobody watches them |
| `workflows` | native workflow runs, controls and approvals | dropped; approvals fall back to the session |
| `backgroundSubagents` | background subagents a session still tracks | dropped |
| `interaction` (optional) | an interaction broker | absent. `@experimental`: no adapter calls it; see [Experimental and implementation-specific members](#experimental-and-implementation-specific-members) |
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

## Frozen external contracts

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
that environment without injecting tool preload settings and, on v3, sets
`KIRO_TRUST_CLASSIFIER_MODE=enforce` unless the caller set it. With a `launch` override it uses the parent
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
- Kiro runs it on an agent configuration the host supplies
  (`KiroAdapterOptions.restrictedAgent`, with `SessionProfilePort.toolset`)
  and checks the session's tools against that catalog. Without it, or with a
  `launch` override, Kiro refuses it (`SessionProfilePort.unsupportedError`).
- Crew refuses it.
- A restricted Codex session cannot start subagents: Codex refuses the
  spawn, and if a child thread starts anyway the adapter ends the turn with
  `runtime_error` `codex_subagent_blocked` and interrupts the parent and
  every child.

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

## Experimental and implementation-specific members

These members are implementation details or experimental. Experimental members
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
  out of the generated validation declarations.
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

## Building and packing

From the repository root:

```bash
npm run build -w michi-runtime        # dist/
npm run pack:check -w michi-runtime   # dist/, then .pack/<name>-<version>.tgz
```

Neither publishes anything. `build` compiles `src/` to CommonJS with
declarations in `dist/` (`tsconfig.build.json`, `scripts/build.mjs`).
`pack:check` stages `dist/`, this README and a private package.json for local validation in
`.pack/package/`, runs `npm pack` there, checks the tarball, compiles its
declarations as a TypeScript host would (strict, `skipLibCheck` off, `node10`
and `nodenext` resolution), and loads it the way a host does
(`scripts/packSmoke.mjs`). TypeScript hosts also need `@types/node`. It
fails when the public declarations reach a type that no entry exports, unless
`REACHABLE_UNEXPORTED` in `scripts/packageLayout.mjs` lists it with a reason.

`pack:check` also checks `examples/minimal-server-host.ts` against the
unpacked tarball: it imports node builtins and the public entries only, it
compiles (strict, `nodenext`, `verbatimModuleSyntax`, `erasableSyntaxOnly`),
and `--check --runtime all` under a scratch HOME builds all four runtimes,
listens on `http://127.0.0.1:<port>` and exits 0 without starting an agent.
That listener and the one `packSmoke.mjs` opens for the slot provider are
loopback only, on a free port, and closed when their check ends.

The private local validation artifact:

- exports `.`, `./mcp-host` and `./adapters/{kiro,crew,codex,claude,acp}` only,
  each with `types`, `import` and `require` conditions. `require` gets the
  CommonJS module and `import` an `.mjs` wrapper that re-exports that same
  module, so both share one instance (one session directory behind
  `createDefaultHost`, for example). There is no `internal/*`. TypeScript's
  `node10` resolution, which reads no `exports`, finds the subpaths' types
  through `typesVersions`.
- depends on `ws` and `@modelcontextprotocol/sdk` only. Michi's shared workspace
  remains local: the modules used by this validation artifact are copied into
  `dist/vendor/michi-shared/`.
- carries Crew's ACP adapter and MCP relay as self-contained CommonJS bundles
  in `dist/adapters/crew/` (`crewAcp.js`, `crewMcp.js`, `crewMcpHost.js`),
  where the Crew adapter looks for them, and the Codex Stop hook runner in
  `dist/adapters/codex/assets/`.
- needs Node.js 22 or later (`engines.node`).
- does not export `package.json`; a host checks the contract it was built
  against with `RUNTIME_CONTRACT_VERSION`.
- types its `import` condition with the CommonJS declarations. Checkers that
  compare each condition's types with its module, such as arethetypeswrong,
  report this as "Masquerading as CJS"; the `.mjs` wrapper re-exports the
  CommonJS module as its default and its named exports, which is what those
  declarations describe, so TypeScript and Node agree.

### Claude Agent SDK peer

The package has `@anthropic-ai/claude-agent-sdk` as an optional peer. Michi
provides the version listed in `peerDependencies` through its root installation.
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
