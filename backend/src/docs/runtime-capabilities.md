# Runtime capabilities in Michi

Applies to: registered Kiro CLI, Crew, Pi, Claude and Codex integrations. Source checked: 2026-10-16 against runtime factories, capability descriptors and attachment adapters. This is an integration reference, not a claim that every upstream version/model has passed live acceptance.

## Read this table

Native means Michi connects to a runtime facility. Michi-managed means the application implements the behavior. Conditional means engine, model, session state or provider support matters. An upstream feature can exist without being connected to Michi.

| Capability | Kiro CLI | Kiro Crew | Pi | Claude | Codex |
| --- | --- | --- | --- | --- | --- |
| Connection | CLI over ACP | Bundled ACP adapter → official local Gateway | Provider APIs in process | CLI stream-json | CLI app-server JSON-RPC |
| Model selection | CLI-discovered; engine dependent | Gateway models | Provider/model catalog | CLI catalog | app-server catalog |
| Reasoning control | Engine/model dependent | Gateway/model dependent | Provider/model dependent | Model dependent | Model dependent |
| Ordinary chat permission modes | Ask / Trust | Ask / Trust | Ask / Trust | Ask / Trust / YOLO | Ask / Trust / YOLO |
| Michi tools | Shared MCP | Official broker relay | Direct in-process tools | Shared MCP | Shared MCP |
| Product docs | `michi_docs` | Through relay discovery/call | `michi_docs` | `michi_docs` | `michi_docs` |
| Image input | ACP image blocks; CLI/model support needed | Not supported by adapter | Image blocks; model support needed | Image blocks; model support needed | Local image input; model support needed |
| Other file attachments | Paths supplied for tool reads | No image/audio support; do not assume generic rich attachment ingestion | Paths supplied for tool reads | Paths supplied for tool reads | Paths supplied for tool reads |
| Same-turn steer | Native; engine dependent | Unavailable to official App callers | Native at assistant boundary | Unavailable in this integration | Native |
| Busy-input fallback | Michi queue where applicable | Next-turn queue | Michi queue where applicable | Next-turn queue | Michi queue where applicable |
| Native resume | Conditional native load | Gateway session load | Text/context reconstruction | Native resume | Native thread resume |
| Branch/fork | Native for compatible idle parents; text fallback | Independent Gateway transcript fork with context replay | Michi context-based branch | Native for compatible idle parents; text fallback | Native for compatible idle parents; text fallback |
| Manual compact from Michi | Connected; engine/version dependent | Unavailable; Crew manages automatic compaction | Unavailable | Unavailable | Connected |
| Dedicated Crew Memory controls | Not applicable | Read & learn / Read only / Off | Not applicable | Not applicable | Not applicable |
| Native subagent visibility | Experimental/version dependent | Dedicated updates not connected | No native roster | Inferred from tool activity | Native child discovery with projected events |
| Usage display | Engine/version dependent | Do not assume full billing data | Provider usage fields | No fabricated usage/cost when unavailable | Native token-usage events |

## Shared Michi features

Workspace history, panes, branches, Artifacts, source references, search, digests, ordinary queues and durable turn replay belong to Michi. They do not imply identical native runtime state or filesystem isolation. A native subagent roster, a Michi conversation branch and an Agent Run are different objects.

Tool availability also depends on configuration and capability allowlists. A selected template may omit tools. Trust cannot expose a missing tool; native provider authentication is independent of Michi permission mode.

## Kiro engines and Crew

Kiro CLI engines have separate protocol behavior. Crew reuses Michi's Kiro adapter layer but pins its own engine independently of `MICHI_KIRO_ENGINE`. Changing that variable does not enable Kiro private steer/compact extensions in Crew.

Local Kiro V3 can preload Michi tool schemas while external MCP tools remain deferred. This is not a guarantee that every external tool appears directly. Use the actual engine's discovery mechanism.

Crew requires the full App setup, required MCP and sessionApproval. Daily controls remain in Michi. Its default `michi-crew` template carries fixed integration instructions; another template must preserve equivalent instructions and MCP configuration.

## Native sessions are conditional

Native Resume and Native Fork switches do different things. Native forks require compatible idle parents and usable native history. A text fallback preserves conversational context, not an exact copy of hidden native state.

Crew's fork preserves its own transcript/Memory semantics; do not call it a Kiro CLI checkpoint. Pi's reconstruction is Michi-managed. See `sessions-and-recovery`.

## Permissions are not one universal sandbox

Codex Trust retains its native sandbox and permits workspace writes; YOLO requests full native access. Claude YOLO uses the CLI bypass mode; Michi does not verify an equivalent OS sandbox for its ordinary integration. Kiro/Crew depend on their upstream policies. Pi's path checks do not make arbitrary shell execution OS-isolated. See `permissions` before relying on containment.

## Verify a capability on your installation

1. Identify backend, runtime, engine/CLI/Gateway version and model.
2. Check whether the control is available for that specific chat.
3. Run a small disposable example with a clear expected result.
4. Inspect the tool/result or resulting file, not just the button or model's assertion.

Success check: the requested behavior actually occurred in the selected runtime. A mock test, descriptor or an upstream documentation page alone is not live provider acceptance. Crew's canonical guide records its dated acceptance scope and unverified platform cases.

Related documents: `runtimes`, `permissions`, `sessions-and-recovery`, `crew`, `custom-agents`.
