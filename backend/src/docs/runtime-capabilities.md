# Runtime capabilities in Michi

Applies to: registered Kiro CLI, Crew, Pi, Claude and Codex integrations. Source checked: 2026-10-16; Claude SDK integration, Codex modes and login check, kiro-cli 2.35.1 and Crew Gateway 0.11.0.1 capabilities updated 2026-10-29. This is an integration reference, not a claim that every upstream version/model has passed live acceptance.

## Read this table

Native means Michi connects to a runtime facility. Michi-managed means the application implements the behavior. Conditional means engine, model, session state or provider support matters. An upstream feature can exist without being connected to Michi.

| Capability | Kiro CLI | Kiro Crew | Pi | Claude | Codex |
| --- | --- | --- | --- | --- | --- |
| Connection | CLI over ACP | Bundled ACP adapter → official local Gateway | Provider APIs in process | Agent SDK with installed CLI | CLI app-server JSON-RPC |
| Model selection | CLI-discovered; engine dependent | Gateway models | Provider/model catalog | CLI catalog | app-server catalog |
| Reasoning control | Engine/model dependent | Gateway/model dependent | Provider/model dependent | Model dependent | Model dependent |
| Ordinary chat permission modes | Ask / Trust | Ask / Trust | Ask / Trust | Ask / Trust / YOLO | Ask / Trust / YOLO |
| Work modes (composer agent menu) | Kiro agents from the CLI | Crew templates | None | Default / Plan in chats; separate from the permission mode; not in Agent Runs | Default / Plan collaboration modes; separate from the permission mode |
| Michi tools | Shared MCP | Official broker relay | Direct in-process tools | Shared MCP | Shared MCP |
| Product docs | `michi_docs` | Through relay discovery/call | `michi_docs` | `michi_docs` | `michi_docs` |
| Image input | ACP image blocks; CLI/model support needed | Not supported by adapter | Image blocks; model support needed | Image blocks; model support needed | Local image input; model support needed |
| Other file attachments | Paths supplied for tool reads | No image/audio support; do not assume generic rich attachment ingestion | Paths supplied for tool reads | Paths supplied for tool reads | Paths supplied for tool reads |
| Same-turn steer | Native; engine dependent | Unavailable to official App callers | Native at assistant boundary | Native in chats: joins the turn at its next tool round, or runs right after it within the same Michi turn; Agent Runs use the next turn | Native |
| Busy-input fallback | Michi queue where applicable | Next-turn queue | Michi queue where applicable | Michi queue where applicable | Michi queue where applicable |
| Native resume | Conditional native load | Gateway session load | Text/context reconstruction | Native resume | Native thread resume |
| Branch/fork | Native for compatible idle parents; text fallback | Independent Gateway transcript fork with context replay | Michi context-based branch | Native historical fork when a saved message position exists; exact text fallback | Native for compatible idle parents; text fallback |
| Manual compact from Michi | Connected; engine/version dependent | Connected (`/compact` on the chat's own idle Gateway slot); Crew also compacts automatically | Unavailable | Connected (`/compact` between turns) | Connected |
| Dedicated Crew Memory controls | Not applicable | Read & learn / Read only / Off | Not applicable | Not applicable | Not applicable |
| Native subagent visibility | Experimental/version dependent | Gateway subagent events for the chat's own slot; each spawn is approved in the Crew dashboard, not Michi | No native roster | Native task lifecycle and forwarded subagent messages | Native child discovery with projected events |
| Usage display | Native credits and context %; no token counts or cost | Native per-turn credits and context %; no token totals | Provider usage fields | Native per-turn token counts of the main agent; no cost (the CLI only estimates list prices) | Native token-usage events |

## Shared Michi features

Workspace history, panes, branches, Artifacts, source references, search, digests, ordinary queues and durable turn recovery belong to Michi. They do not imply identical native runtime state or filesystem isolation. A native subagent roster, a Michi conversation branch and an Agent Run are different objects.

Tool availability also depends on configuration and capability allowlists. A selected template may omit tools. Trust cannot expose a missing tool; native provider authentication is independent of Michi permission mode.

## Pages Assistant and automatic maintenance

Source checked for this section: 2026-10-26. The restricted Meta agent profile supports Pi, Claude, Codex and Kiro; Crew is not supported for this profile. On Codex these sessions cannot use sub-agents: Codex refuses the spawn, and if a sub-agent starts anyway Michi stops the turn and the sub-agent and reports an error. The Assistant and background maintenance use **Settings → Meta agent**, independently of ordinary chat settings. Every session must pass a runtime tool-catalog check; a configured runtime can still fail startup or provider authentication.

The current Pages/Meta agent interface supports only the local backend. Ordinary workspace Page tools, the Assistant catalog and maintenance tools are separate capabilities; Agent Runs do not automatically inherit them. See `pages-and-components` and `pages-maintenance`.

## Kiro engines and Crew

Kiro CLI engines have separate protocol behavior. Michi starts V3 unless `MICHI_KIRO_ENGINE=v2` is set. Chats keep the engine their native session was created with: a V2 chat resumed under V3 cannot load its native history and is reconstructed from Michi's transcript instead. Crew reuses Michi's Kiro adapter layer but pins its own engine independently of `MICHI_KIRO_ENGINE`. Changing that variable does not enable Kiro private steer/compact extensions in Crew. Only Kiro V3 offers Approve for me (see `permissions`).

Local Kiro V3 can preload Michi tool schemas while external MCP tools remain deferred. This is not a guarantee that every external tool appears directly. Use the actual engine's discovery mechanism.

On Kiro CLI (both engines, checked with 2.35.1), Stop is confirmed by Kiro itself: the stopped prompt ends with a cancelled result, normally within a few tens of milliseconds, and the same session takes the next message. If Kiro does not confirm within the cancel deadline, Michi reports the Stop as dispatched only and keeps the session for recovery. On Crew (Gateway 0.11.0.1), Stop is confirmed by the Gateway's own record of the stop; without that record it is reported as dispatched only.

Crew requires the full App setup, required MCP and sessionApproval. Daily controls remain in Michi. Its default `michi-crew` template carries fixed integration instructions; another template must preserve equivalent instructions and MCP configuration.

## Native sessions are conditional

Native Resume and Native Fork switches do different things. Native forks require compatible idle parents and usable native history. A text fallback preserves conversational context, not an exact copy of hidden native state.

Crew's fork preserves its own transcript/Memory semantics; do not call it a Kiro CLI checkpoint. Pi's reconstruction is Michi-managed. See `sessions-and-recovery`.

## Permissions are not one universal sandbox

Codex Trust retains its native sandbox and permits workspace writes; YOLO requests full native access. Codex Plan mode is a working mode, not a permission: it keeps the chat's Ask / Trust / YOLO policy and sandbox, so do not treat it as a write barrier. Claude YOLO uses the CLI bypass mode; Michi does not verify an equivalent OS sandbox for its ordinary integration. Claude Plan mode lets Claude explore and propose a plan; approving that plan is always your decision, also under Trust and YOLO, and an approved plan returns the chat to Default under its permission mode. The CLI enforces what plan mode allows; tools it still asks about follow the chat's permission mode. Kiro/Crew depend on their upstream policies. Pi's path checks do not make arbitrary shell execution OS-isolated. See `permissions` before relying on containment.

## Verify a capability on your installation

1. Identify backend, runtime, engine/CLI/Gateway version and model.
2. Check whether the control is available for that specific chat.
3. Run a small disposable example with a clear expected result.
4. Inspect the tool/result or resulting file, not just the button or model's assertion.

Success check: the requested behavior actually occurred in the selected runtime. A mock test, descriptor or an upstream documentation page alone is not live provider acceptance. Crew's canonical guide records its dated acceptance scope and unverified platform cases.

Related documents: `runtimes`, `permissions`, `sessions-and-recovery`, `crew`, `custom-agents`.
