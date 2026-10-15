# Kiro Crew runtime — official Gateway only

Michi launches its bundled ACP adapter and authenticates as the `michi-crew-runtime`
App against the unmodified official Kiro Crew Gateway. No Crew source patch,
companion Gateway, owner token, or `/app-runtime` API is required.
Validated against installed **0.8.0-insider.14** on 2026-10-07.

## 简单使用

1. 启动官方 Kiro Crew。在 Michi composer 的 Runtime 中选择 **Kiro Crew**。
   新对话默认使用 App 自带的 **michi-crew** 模板；固定指令放在 Agent 中，
   用户消息只携带必要上下文和简短格式说明。明确选择的模板和旧会话身份保持不变。
2. 在 **Settings → Model → Memory** 选择新对话的记忆模式；此选项仅在
   当前 Runtime 为 **Kiro Crew** 时显示，位于 **FOLLOW-UPS** 上方：
   - **Read & learn**：读取已有记忆，也允许保存可复用偏好。
   - **Read only**：读取记忆，不新增或修改记忆。
   - **Off**：不读取、不写入长期记忆。
3. 已创建对话的模式固定，fork 继承原模式；想换模式请调整 Settings 后新建对话。
4. 普通聊天、文件工具、模型与模板选择、恢复和历史分叉可以直接用。
   审批模式在 **Michi Settings → Model → Permissions** 选择。
   **Use global permissions** 开启时统一选择，composer 隐藏审批开关；
   关闭后可以在各对话的 composer 选择 **Ask / Trust**。变更从下一轮生效。
   启用下方 `sessionApproval` 授权后，审批卡在 Michi 显示；未启用时，
   审批仍在 Crew 中处理，单对话权限控件显示 **Crew approvals**。
5. 要使用 Michi 的线程、pane、artifact 或分支工具，按下方步骤配置可选 MCP。
   要在 Michi 中点击批准或拒绝，再额外开启可选审批授权。

Memory 控制的是 Crew 的长期学习，不等于删除聊天记录。Michi 自己仍保存对话。
Crew 模板、治理策略和绑定身份也可能限制 Memory 工具。

### 运行已构建的工作树版本

在这份 Michi 工作树根目录运行（使用独立预览数据）：

```sh
VITE_API_URL=/api npm run build
PORT=3010 MICHI_DATA_DIR="$HOME/.michi-crew-preview" NODE_ENV=development npm start
```

然后打开 `http://localhost:3010`，创建 workspace，在 composer 选择 **Kiro Crew**。
这个命令不会替换已安装的桌面 App；Ctrl+C 停止预览。首次运行或源码变化后先执行
上面的同源构建命令。官方 Crew 的 App/MCP 配置只需按下文完成一次。

### 提示词和响应时间

App 的 `agents/michi.json` 声明 **michi-crew**，包含简洁的固定指令、原生文件/研究
工具、Memory 和 Crew 控制工具。工作区指令、引用资料和分支历史仍按会话传入。
摘要、标题和追问随最终回答返回，简单消息不会为元数据触发 MCP 工具发现。
自定义模板可在 Crew Agent Capabilities 中添加额外 MCP、技能或其他原生能力。

Crew 会把模板提示词放入自己的会话上下文；kiro-cli/KAS 也有原生 Agent 指令通道。
其他 Crew 后端可能只通过上下文投影，不能保证每个后端都使用真正的 system role。
精简指令减少输入和工具往返，但模型、推理档位、Memory 检索和排队仍会影响耗时。
不会自动降低用户选择的 Extra high；日常简短对话可以手动选 Medium/High。

第一次加入此模板后，如果启用了 Michi MCP，结束正在运行的任务再重启 Gateway，
让官方 Stub overlay 包含新模板。只点 App Sync 不会生成新模板的 broker 路由。

开发 watcher 的重启会中断本轮。适配器退出时停止自己启动的 Crew 工作并释放 MCP
绑定；保留原生历史。旧任务仍在运行时拒绝重试，先在 Crew 中完成或停止它。

## Install the base App

Build Michi normally (this does not replace the installed desktop app):

```sh
npm run build
kirocrew app install "$PWD/backend/src/agents/crew/app"
kirocrew app enable michi-crew-runtime
```

For an existing App, use Crew Apps' supported Update/Sync flow and preserve its
secret and existing sessions. Do not uninstall/reinstall to update. The base
manifest requests only `/api/chat`, `/api/models`, and `/api/agents/catalog`.
If `MICHI_ENABLED_RUNTIMES` is set, include `crew`.

## Optional Michi MCP

Prepare an App directory pointing at the built Michi relay:

```sh
node backend/scripts/crew-setup.cjs --mcp
```

The command prints a prepared directory. Install or update **that directory** in
Crew Apps. In official **Developer → MCP Management**, find `michi-crew-runtime:michi`, inspect
its Node command/arguments, enable **Stub / Routed**, approve the displayed launch,
then restart the **Gateway** when requested (`kirocrew restart --port 5476`).
In 0.8.0-insider.14, Stub changes wait for the next Gateway start, even for new
chats. **Apply & Restart** on Agent Capabilities only relaunches chat agents and
does not activate a new Stub route. Finish or stop active work before restarting.
Keep the referenced Michi build at that path.
The setup command prepares files only; it does not alter Crew config or accept grants.

The official broker must inject `kirocrew.caller` metadata. A plain stdio or HTTP
entry, `poolable: true`, or a guessed session environment is insufficient. The
`mcp_gateway.enabled` switch controls sharing; it is not the per-server Stub switch.
Use the official UI so its launch approval is recorded too.

Two MCP tools are exposed:

- `michi_list_tools`: obtains the exact current node's tools and input schemas.
- `michi_call_tool`: calls one of those tools with `{tool, arguments}`.

The model's Michi preamble explains this wrapper. Existing workspace ownership,
Agent Run profiles, tool validation and approval checks remain in Michi's MCP
endpoint. Unknown caller identities, missing Stub config, inactive bindings and
foreign sessions fail closed. No model-supplied endpoint or node selects authority.
Crew subagents do not inherit a parent's binding; unregistered child sessions are
refused. Configure the relay on the same host as Michi and Crew.

Bindings exist while a Michi turn runs, use private files, and route to fresh random
Michi MCP URLs. Resume/fork register the appropriate endpoint. Cleanup deletes an
immutable lease, so an old turn cannot delete a newer binding. Small non-secret
slot-hash pointers may remain after cleanup; they contain no usable endpoint.

## Optional in-app approval

Prepare this variant if you want Michi's ordinary **Ask / Trust** controls:

```sh
node backend/scripts/crew-setup.cjs --mcp --approvals
```

Update the App in official Crew Apps, review its `sessionApproval` permission, and
explicitly enable it through Crew's consent flow. Updating an existing registration
may disable it until consent is given. This official grant is **broader than App-only
access**: it also permits control of user-owned Crew chats. Michi deliberately
filters its adapter to its own local, unlinked App sessions. The default App has
no such grant. This is a supported configuration choice, not a narrowed upstream
security boundary.

When granted, Michi clears per-slot Crew Trust at the start of each turn and forwards
pending native tool requests to the normal Michi permission workflow:

- **Ask**: show the pending request in Michi.
- **Trust**: automatically answer requests using the existing Michi policy.
- Crew has no Michi **YOLO** control; a global Michi YOLO preference behaves as Trust.

Crew's existing tool allowlists, governance and operator-enabled global YOLO still
apply. Michi cannot revoke global Crew YOLO, so Ask cannot promise to intercept tools
that Crew auto-approves before a request exists. Settings and composer report the
installed grant; a revoked grant fails rather than silently widening access.

Expired permission cards are closed by exact Michi request ID. Before sending a
reply, the adapter checks the latest native card (message ID where present,
otherwise timestamp plus request/tool IDs) and refuses detected reused IDs.
Cancellation drains pending MCP publication and approval work before admitting
a successor turn.
The official approve API accepts only `request_id`: its check and POST are not atomic.
**Do not control the same chat concurrently in Crew and Michi** when using this
optional bridge. An upstream exact-card/turn approval API is needed for that stronger
guarantee. The default Crew approval workflow remains available without this grant.

## Parity and limits

| Capability | Behavior |
|---|---|
| Text/thinking | Gateway SSE through ACP into Michi |
| Tool input/output | Running cards plus own-slot WS enrichment and bounded reconciliation |
| Titles/plans/context | Native Gateway snapshots/events; no invented credit or cost totals |
| Model/reasoning | Gateway selections, including reset to Crew default |
| Agent templates | Composer template modes; private Member identities are not switchable templates |
| Resume | Same owned Gateway slot across adapter restarts |
| Historical fork | Independent transcript fork at a stable message ID, preserving native Memory identity |
| Memory | Native learning/recall, configured in Settings for new Crew chats |
| In-app approval | Optional broad official grant; limitations above |
| Michi MCP | Optional official App stdio relay plus Stub launch approval |
| Same-turn steer | **Unsupported for official App callers**; busy sends are queued follow-ups |
| Compact | Crew automatic compaction; no adapter command for manual compact |
| Subagents | Crew's native tools work; no dedicated Michi roster/control stream |
| Images/audio | Not advertised by the adapter; unsupported blocks are marked omitted |

Send a correction after the current turn, or stop it first. A queued follow-up is
never presented as same-turn steer. Fork replays transcript context; it is not a
kiro-cli process checkpoint or a destructive rewind of the parent.

Tool-result events lack a reliable terminal success flag. Cards settle when the
turn ends; completion means the enclosing turn ended, not that every tool succeeded.
Enrichment is bounded to 5 × 500 history rows, 2,048 events, 16,000 characters per
field, and 2 MiB WS frames. Text remains usable when enrichment is unavailable.

## Environment

| Variable | Default / purpose |
|---|---|
| `CREW_GATEWAY_URL` | `http://127.0.0.1:5476`, loopback only |
| `KIROCREW_PORT` | `5476` when URL is absent |
| `KIROCREW_HOME` | `~/.kiro/crew` |
| `MICHI_CREW_APP` | `michi-crew-runtime` |
| `MICHI_CREW_AGENT` | Explicit new-slot override; otherwise prefer installed `michi-crew`, with a logged Gateway-default fallback |
| `MICHI_CREW_MEMORY_MODE` | Fallback default; saved Settings takes precedence |
| `MICHI_CREW_MCP_DIR` | `~/.michi/crew-mcp`; adapter and relay must agree |
| `MICHI_CREW_ACP_BIN` | Optional external ACP executable |

Restart the Michi backend after process-level changes. The default Memory preference
is stored in Michi SQLite, scoped to the desktop or authenticated cloud owner. Saved
native session modes cannot be overwritten by graph persistence.

See [validation evidence](VALIDATION.md). Optional approval and official broker live
acceptance must be distinguished from mocked contract tests.
