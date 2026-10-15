# Michi × KiroCrew 接入教程

更新：2026-10-12。适用于 Michi 的 `dev` 源码和官方 KiroCrew Gateway。

日常使用只需要：启动 KiroCrew → 在 Michi 选择 **Kiro Crew** → 新建对话。
需要 Michi 的分支、artifact 等工具或在 Michi 中审批时，再完成下面的一次性配置。

## 1. 从 dev 构建 Michi

在终端执行：

```sh
cd /Users/yonghuyu/rabbitholes
git branch --show-current
node --version
kirocrew --version
VITE_API_URL=/api npm run build
```

分支应为 `dev`，Node.js 需要 22 或更新版本。首次安装依赖时先运行 `npm install`。
构建会生成 `backend/dist/crewAcp.js` 和 `backend/dist/crewMcp.js`。

可以用独立数据目录启动预览：

```sh
PORT=3010 MICHI_DATA_DIR="$HOME/.michi-crew-preview" NODE_ENV=development npm start
```

打开 `http://localhost:3010`。如端口被占用，换一个空闲端口；Ctrl+C 停止预览。
预览数据与原来的 Michi 数据分开，因此原有工作区不会自动出现在预览中。
普通 `npm run build` 不会替换已安装的桌面 App。

## 2. 安装或更新官方 Crew App

先启动官方 KiroCrew，默认 Gateway 为 `http://127.0.0.1:5476`。
Michi 通过名为 `michi-crew-runtime` 的 App 接入。

**首次接入、只需要基本聊天**，执行：

```sh
kirocrew app install "$PWD/backend/src/agents/crew/app"
kirocrew app enable michi-crew-runtime
```

**已经安装过**，在 Crew 的 **Apps** 页面更新已有 App，保留 App secret 和会话。
使用官方 **Update / Sync** 流程；不要为了更新卸载已有 App。
如果准备启用下一节的 MCP 和审批，可以直接安装或更新生成的增强版 App，无须先安装基础版。

如果 Michi 设置了 `MICHI_ENABLED_RUNTIMES`，列表中需要包含 `crew`。
默认没有设置这个变量时，不需要额外配置。

## 3. 启用 Michi MCP 和 Michi 内审批

在 **dev 根目录**执行：

```sh
node backend/scripts/crew-setup.cjs --mcp --approvals
```

命令会打印 `Prepared App: /…/michi-crew-app-…`。
复制这个实际目录，在 Crew **Apps** 页面安装或更新 **michi-crew-runtime**。
脚本只准备文件；安装、启用和授权仍走官方 Crew 流程。

需要核对两项配置：

1. **审批授权**：查看 `sessionApproval` 权限，并在 Crew 中启用 App / 同意聊天控制。
   更新后 App 可能暂时禁用，完成授权后应显示 **Enabled**。
2. **MCP 路由**：打开 **Developer → MCP Management**，找到
   `michi-crew-runtime:michi`，检查 Node 启动命令，开启 **Stub / Routed**，批准启动。
   Node 参数应指向：

```text
/Users/yonghuyu/rabbitholes/backend/dist/crewMcp.js
```

从旧 worktree 切换到 dev 时，尤其要确认这里不再指向
`crew-enhancements/rabbitholes/backend/dist/crewMcp.js`。
Node 可执行文件应是本机可用的 Node.js 22+；之后保持这份构建和路径可用。

等 Crew 当前任务结束或手动停止后，重启 **Gateway**：

```sh
kirocrew restart --port 5476
```

只点击 Agent Capabilities 的 **Apply & Restart** 会重启聊天 Agent，不能替代 Gateway
重启。加入新模板或更改 Stub 后，需要 Gateway 重新生成 broker 路由。

`sessionApproval` 是官方的较广权限，也覆盖用户自己创建的 Crew 会话。
Michi 的适配器只处理自己所属的本机、未链接 App 会话；这是 Michi 的访问限制。
开启后，在使用审批桥时避免同时在 Crew 和 Michi 控制同一对话。
只想挂 MCP 时用 `--mcp`；只想接入审批时用 `--approvals`。

## 4. 在 Michi 中使用

在 **Settings → Model** 或新对话 composer 的 Runtime 菜单选择 **Kiro Crew**。
新对话默认使用 **michi-crew** 模板；可在 composer 选择模型、推理档位和其他模板。
已有会话保留原模板身份，恢复不会把它偷偷换成新模板。

**Memory** 位于 **Settings → Model**，在 **FOLLOW-UPS** 上方；Settings 当前
Runtime 为 Crew 时显示。它设置新 Crew 对话的默认模式：

| 选项 | 用法 |
| --- | --- |
| Read & learn | 读取记忆，也允许学习和保存可复用偏好。 |
| Read only | 读取记忆，不新增或修改记忆。 |
| Off | 不读取、不写入长期记忆。 |

已有对话的 Memory 模式固定，fork 继承原模式。想换模式，改 Settings 后新建对话。
Off 不会删除聊天记录；Michi 仍保存对话历史。

模板中包含固定的 Michi 指令，用户消息只携带动态上下文和简短的输出格式说明。
模型、推理档位、Memory 检索和排队仍会影响响应时间；简短交流可手动选 Medium / High。

## 5. 审批在哪里选，四个按钮有什么用

在 **Michi Settings → Model → Permissions** 设置审批模式。

- **Use global permissions 开启**：所有对话统一使用全局模式，composer 隐藏审批开关。
- **关闭**：各对话在 composer 中选择 **Ask / Trust**。
- **未授予 sessionApproval**：审批由 Crew 处理，单对话控件显示 **Crew approvals**。
- **已授予**：Ask 把原生工具请求显示在 Michi；Trust 按 Michi 策略自动答复。

Crew 没有单独的 Michi YOLO 选项；全局 Michi YOLO 对 Crew 按 Trust 处理。
Crew 自己的 allowlist、治理策略和全局 YOLO 仍先执行。
如果 Crew 已自动批准，没有原生请求产生，Michi Ask 无法再拦截。

| 审批按钮 | 实际范围 |
| --- | --- |
| Deny | 拒绝这一次，不保存授权。 |
| Allow Once | 只批准当前请求。 |
| Trust this tool | 为当前 Michi 对话保存该工具的授权，可跨恢复保留。缺少稳定工具身份时禁用。 |
| Trust all tools for this session | 只信任当前 Runtime 会话中的工具；不写数据库，会话重建或显式修改权限后失效。 |

想撤销信任：全局模式下重新选 **Ask**，清除该用户的对话授权；单对话模式下
在该对话重新选 **Ask**，只清除本对话授权。fork 不继承这些工具授权。
按钮默认灰色，悬停或聚焦时显示颜色；没有专用快捷键，可点击或用 Tab + Enter / Space。

## 6. 两分钟自检

1. 新建 Crew 对话，发“用一句话说明你能做什么”。应看到回复、标题和所选模型 / 模板。
2. 在 Settings 选择 Off，再新建一条对话，确认新对话使用 Off。
3. 启用了 MCP 时，发“调用 michi_list_tools，列出当前 Michi 对话可用工具”。
   应出现 MCP 工具结果；仅看到 App 已配置不能证明路由已生效。
4. 已启用审批桥且为 Ask 时，在临时测试目录请求一个工具操作。
   低风险读取可能被 Crew 自动批准。出现审批卡后先用 Allow Once，再用 Deny 验证拒绝。
5. 完成一轮后重新打开对话，并试一次历史 fork，确认恢复和分支可继续聊天。

## 7. 常见问题

| 现象 | 检查方式 |
| --- | --- |
| Crew 不可用 / 无法建会话 | 检查官方 Gateway 正在运行、App 为 Enabled、Node 和 ACP 构建存在；自定义 Gateway 仅支持 loopback。 |
| MCP 没有 caller identity / 找不到路由 | 确认官方 Stub / Routed 已开启且批准启动；重启 Gateway，新建测试对话。普通 stdio 配置不能替代官方 caller 路由。 |
| 合入 dev 后 MCP 仍走旧代码 | 重新运行 dev 的 setup 脚本，用生成目录更新 App，核对 Node 参数中的绝对路径。 |
| Ask 不弹审批卡 | 确认 sessionApproval 已同意且 App Enabled；查看 Crew allowlist / 全局 YOLO 是否先自动批准；检查全局权限设置。 |
| 修改 Memory 后旧对话没有变化 | 已有会话模式固定；改默认值后新建对话。 |
| 响应慢 | 查看是否选了 Extra high / Max、排队或等待审批；先用短消息和 Medium / High 排查。 |
| 开发重启后本轮中断 | watcher 重启会终止适配器；确认原生任务已经停止，再恢复或重试。 |
| 运行源码但桌面 App 仍是旧版 | 普通构建只更新源码产物；用预览访问，或有意执行桌面打包安装流程。 |

改进程环境变量后重启 Michi backend。常用覆盖项：
`CREW_GATEWAY_URL`（默认 `http://127.0.0.1:5476`）、
`KIROCREW_HOME`（默认 `~/.kiro/crew`）、
`MICHI_CREW_MCP_DIR`（默认 `~/.michi/crew-mcp`，Michi 与 relay 必须一致）。
不需要把 App secret 复制进提示词、教程或环境文件。

## 8. 当前边界与验证范围

已接入文字 / thinking、原生工具输入输出、模型 / reasoning / 模板、恢复、稳定历史
fork、Memory、可选 Michi MCP 和可选 Michi 审批。

官方 App 调用者目前**不支持同轮 steer**；忙时发送的消息进入下一轮队列。
Crew 自动 compact 可用，但没有 Michi 手动 compact 命令。
没有独立的 Crew 子 Agent 管理界面，适配器未接入图片 / 音频。
私有 Member 的 Memory 继承还没有真实验收。

历史真实 Gateway 验收在 **2026-10-07 / 0.8.0-insider.14** 完成，涵盖 Memory、
恢复 / fork、MCP 隔离和 Allow Once / Deny。Trust 两项由受控自动化测试验证。
2026-10-12 本机 CLI 为 **0.8.0-insider.16**；这次 dev 整合的自动测试和构建结果
见 [VALIDATION.md](VALIDATION.md)，不等同于对 .16 重跑完整真实验收。

更详细的运行原理见 [Runtime README](README.md)，审批语义见 [APPROVALS.md](APPROVALS.md)。
