# 在 Michi 中使用 KiroCrew

更新于 2026-10-13，适用于 Michi Crew App **0.6.0** 和官方 Crew **0.9.0-insider.6**。

Crew 提供后端；一次接入后，聊天、审批、模型、Memory、恢复和分叉都在 **Michi** 操作。**Michi MCP 和 sessionApproval 必选，App 已默认包含。** 保持 Crew 运行。

## 1. 更新 Michi

默认安装器把代码和构建放在 `~/.michi`；macOS 桌面 App 位于 `~/Applications/michi.app`。先更新到包含 Crew App 0.6.0 的版本：

```sh
michi update
```

macOS 更新会重建并替换 App，同时退出 Michi，之后重新打开。本地 dev 提交必须发布到安装器使用的分支后，其他用户才能通过 update 获得。

默认安装现在已经包含完整的 `~/.michi/crew-app`，**首次接入无须运行 setup 脚本，也无须复制文件**。只有桌面包产生的数据目录不算代码安装目录；安装目录应包含 `crew-app/launch.py`、`backend/dist/crewMcpHost.js`、`crewMcp.js` 和 `crew-node.json`。

## 2. 在 Crew 中直接安装

启动官方 Crew 并登录。本地默认 Gateway 地址是 `http://127.0.0.1:5476`。

打开 **Apps / Discover → Manage app sources → Install from path**，填入自己的绝对路径：

| 平台 | 示例，替换用户名 |
| --- | --- |
| macOS | `/Users/你的用户名/.michi/crew-app` |
| Linux | `/home/你的用户名/.michi/crew-app` |
| Windows | `C:\Users\你的用户名\.michi\crew-app` |

不要直接输入未展开的 `$HOME`、`${HOME}` 或 `~`。macOS/Linux 可以用 `printf '%s\n' "$HOME/.michi/crew-app"` 显示路径。

App 名称是 **michi-crew-runtime**，默认模板是 **michi-crew**。Crew 保存该路径作为后续 Sync 的来源。自定义安装、工作树和旧生成来源请看第 8 节；不要为了更新卸载旧 App。

## 3. 授权和后续更新

1. 阅读并同意 **sessionApproval**，确认 App **Enabled**。它让 Michi 接收和回答 Crew 的待审批请求，日常 **Ask / Trust 在 Michi 选择**。官方授权还包含用户自己在 Crew 创建的聊天；Michi adapter 只操作自己的本地、未链接 App 会话。
2. 在 **Developer → MCP Management** 找到 `michi-crew-runtime:michi`，启用 **Stub / Routed**，检查并批准启动。Sync 后重新加载此页面；如果显示 **command changed**，必须批准新的 Python 启动命令，保存过 Stub 选择不代表新命令已获批。如果没有 Developer，先打开 **Settings → Developer → Developer Mode**。
3. manifest 的命令是 `python`，由 Crew 解析为自己的解释器。启动器从 Michi 构建记录 `backend/dist/crew-node.json` 找到 Node，要求 **22.19 或更新**，不依赖 GUI 的 Node PATH。默认安装目录在 Python 内解析，无须 Crew 替换参数中的 HOME。
4. 首次安装，或从 **0.6.0 之前**的 App 升级后，必须重启 **Gateway**，让新模板、broker 路由和 Python host 启动命令替换缓存。即使 Sync 没有提示也要重启；先结束或停止活跃任务。默认服务管理的实例用 `kirocrew restart`。Agent Capabilities 的 **Apply & Restart** 只重启聊天 Agent。

以后默认安装用户只需：

```sh
michi update
```

然后到 **Apps / Library → Michi Crew Runtime → Sync**。无需生成或复制；Sync 从同一个 `~/.michi/crew-app` 读取新版，保留 App secret 和数据。Sync 后重新加载 **Developer → MCP Management**；如显示 **command changed**，批准当前新命令。首次从 0.6.0 之前迁移必须重启 Gateway；以后 host、launcher 或 API 变化则按版本说明重启。

Michi 检查已安装 App 的版本；旧版会显示 **Sync Crew App** 并阻止新的 Crew 工作。Sync 后回到 Michi 刷新。

已运行的 MCP 连接会在下一次请求加载兼容的新 relay handler；进行中的调用保留原来的版本，构建间隙保留最后可用 handler。如果版本改变 host、launcher 或 handler API，仍需要重开会话或重启 Gateway，按版本说明操作。

## 4. 在 Michi 中使用

macOS 正常打开桌面 App，或运行 `michi`。Linux 运行 `michi start`，访问打印的
地址；默认是 `http://localhost:4649`。

在 **Settings → Model** 或新对话 composer 的 Runtime 菜单选择 **Kiro Crew**。
完整接入请保持默认 **michi-crew** 模板；模型和推理档位仍可在 composer 选择。
已有会话保留原模板身份。composer 也支持其他 Crew 模板，但它们可能缺少 Michi 指令和
MCP 配置。自定义模板需保留 Michi prompt / 输出约定、`@michi-crew-runtime:michi`
工具引用及其 MCP 配置；切换后重新验证 `michi_list_tools`。

**Memory** 位于 **Settings → Model**，在 **FOLLOW-UPS** 上方；Settings 当前
Runtime 为 Crew 时显示。它设置新 Crew 对话的默认模式：

| 选项 | 用法 |
| --- | --- |
| Read & learn | 读取记忆，也允许学习和保存可复用偏好。 |
| Read only | 读取记忆，不新增或修改记忆。 |
| Off | 不读取、不写入长期记忆。 |

已有对话的 Memory 模式固定，fork 继承原模式。想换模式，改 Settings 后新建对话。
Off 不会删除聊天记录；Michi 仍保存对话历史。

**michi-crew** 模板中包含固定的 Michi 指令，用户消息只携带动态上下文和简短的输出格式说明。
模型、推理档位、Memory 检索和排队仍会影响响应时间；简短交流可手动选 Medium / High。

## 5. 审批在哪里选，四个按钮有什么用

在 **Michi Settings → Model → Permissions** 设置审批模式。

- **Use global permissions 开启**：所有对话统一使用全局模式，composer 隐藏审批开关。
- **关闭**：各对话在 composer 中选择 **Ask / Trust**。
- **Ask**：待审批的原生工具请求显示为 Michi 审批卡。
- **Trust**：Michi 按当前权限策略自动答复待审批请求。

审批始终在 Michi 中进行。缺少或撤销 sessionApproval 授权属于接入未完成，
需要恢复授权才能开始新一轮任务。

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
3. 发“调用 michi_list_tools，列出当前 Michi 对话可用工具”。
   应出现 MCP 工具结果；仅看到 App 已配置不能证明路由已生效。
4. 选择 Ask，在临时测试目录请求一个工具操作。
   低风险读取可能被 Crew 自动批准。出现审批卡后先用 Allow Once，再用 Deny 验证拒绝。
5. 完成一轮后重新打开对话，并试一次历史 fork，确认恢复和分支可继续聊天。

## 7. 常见问题

| 现象 | 检查方式 |
| --- | --- |
| Crew setup required | 运行 setup 脚本更新 App，完成 sessionApproval 授权，开启并批准 Stub / Routed，重启 Gateway。 |
| Crew 不可用 / 无法建会话 | 检查官方 Gateway 正在运行、App 为 Enabled、Node 和 ACP 构建存在；自定义 Gateway 仅支持 loopback。 |
| MCP 没有 caller identity / 找不到路由 | 确认官方 Stub / Routed 已开启且批准启动；重启 Gateway，新建测试对话。普通 stdio 配置不能替代官方 caller 路由。 |
| 安装目录没有 Crew 文件或 Runtime | 升级到包含 Crew 支持的安装版；本地开发合并不会自动发布或更新安装版。 |
| MCP 仍走旧代码 | 自定义安装请检查 MICHI_CREW_INSTALL_DIR；旧生成目录按第 8 节刷新来源。 |
| Ask 不弹审批卡 | 确认 sessionApproval 已同意且 App Enabled；查看 Crew allowlist / 全局 YOLO 是否先自动批准；检查全局权限设置。 |
| 修改 Memory 后旧对话没有变化 | 已有会话模式固定；改默认值后新建对话。 |
| 响应慢 | 查看是否选了 Extra high / Max、排队或等待审批；先用短消息和 Medium / High 排查。 |
| 开发重启后本轮中断 | watcher 重启会终止适配器；确认原生任务已经停止，再恢复或重试。 |
| 桌面 App 仍是旧版 | 使用正常安装更新流程；只修改代码目录或构建 backend 不会更新桌面包。 |

改进程环境变量后重启 Michi backend。常用覆盖项：
`CREW_GATEWAY_URL`（默认 `http://127.0.0.1:5476`）、
`KIROCREW_HOME`（默认 `~/.kiro/crew`）、
`MICHI_CREW_MCP_DIR`（默认 `~/.michi/crew-mcp`，Michi 与 relay 必须一致）。
macOS 打包版读取 `~/.michi/.env`，setup helper 不会读取这个文件。
若自定义 `MICHI_CREW_MCP_DIR`，准备 App 时也需传入同一个绝对路径，例如：

```sh
MICHI_CREW_MCP_DIR="$HOME/custom-crew-mcp" node backend/scripts/crew-setup.cjs
```

两处都使用你的实际目录；默认配置无须覆盖。不需要复制 App secret。

## 8. 旧生成来源和自定义安装

旧用户保留已登记的来源目录和凭据，不会自动迁移到新默认目录。自定义安装或自定义 MCP binding 目录仍使用兼容 helper，在实际安装或已构建工作树运行：

```sh
node backend/scripts/crew-setup.cjs
```

helper 打印 Prepared App 路径，始终包含 MCP 和审批，并设置明确的 `MICHI_CREW_INSTALL_DIR` / `MICHI_CREW_MCP_DIR`。

首次自定义安装，把生成文件复制到专用持久目录，例如 `<自定义安装>/crew-app-prepared`，从它安装。**不要把生成文件覆盖到仓库自带的 crew-app。**

已有 App 用以下命令读取已登记来源（不读取凭据）；自定义 Crew home 需先 export 相同的 KIROCREW_HOME：

```sh
node -p 'require(require("node:path").join(process.env.KIROCREW_HOME || require("node:os").homedir() + "/.kiro/crew", "apps/michi-crew-runtime/installed.json")).source'
```

把新生成文件复制到这个**经过核对的专用生成来源目录**，然后点 Sync。旧临时目录丢失时可以在原路径重建；不要卸载旧 App。若来源是代码 checkout，禁止拿生成文件覆盖它；当前 UI 没有改 source 的入口，迁移需要官方 authenticated update API 显式指定 source，并保留原 App secret 和会话。

## 当前边界和验证范围

已接入文字/thinking、原生工具、模型/reasoning/模板、恢复、历史 fork、Crew Memory、Michi MCP 和审批。官方 App 调用者不支持同轮 steer，忙时消息排到下一轮；自动 compact 可用，但没有 Michi 手动 compact 命令。适配器未接入图片/音频，也没有专用 Crew 子 Agent 管理界面。私有 Member Memory 继承仍未实测。

2026-10-13 使用官方 **0.9.0-insider.6** 验证了 production manifest 的隔离安装/Sync，以及实际安装 App 的 UI Sync。真实模型验证了并发 MCP 隔离、adapter 重启恢复、独立 fork binding 和未绑定会话拒绝。带空格默认 HOME、空 Node PATH、stdio 连接内更新和构建恢复通过实际进程测试。这些实测在 macOS；Windows/Linux 还没有跨平台真实验收。

完整使用细节见 [英文教程](GETTING_STARTED.md)，审批语义见 [APPROVALS.md](APPROVALS.md)。

本次还用官方 broker 在同一真实模型轮次验证了 relay 更新，host 进程未重启；原生审批允许、拒绝、取消及取消后的下一轮通过。Michi 浏览器 UI 中 Allow Once 实际写入预期测试文件，Deny 阻止另一文件生成；隔离旧版配置显示 Sync Crew App，恢复 0.6.0 后恢复 Ask。两种 Trust 按钮有自动化覆盖，本轮未对真实模型逐个手动点击。

默认 `~/.michi` 路径在隔离 HOME 中用官方 Python 和真实 stdio 验证；本机已安装 App 通过自定义工作树兼容配置完成真实 Crew 测试。Windows/Linux 未进行真实平台验收；macOS 安装器和 update 打包链已检查，但未运行会替换用户桌面 App 的安装命令，源码构建及产物单独验证。
