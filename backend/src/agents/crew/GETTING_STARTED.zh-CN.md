# Michi × KiroCrew 接入教程

更新：2026-10-13。适用于已安装的 Michi 和官方本机 KiroCrew Gateway。
终端命令采用 macOS/Linux shell 语法。另有 [英文接入教程](GETTING_STARTED.md)。

KiroCrew 提供后端。完成下面的一次性配置后，在 **Michi** 中聊天、审批工具、选择模型、
设置 Memory、恢复和分叉对话；保持 KiroCrew 运行即可。
**Michi MCP 和 Approvals 是必需的接入能力，默认同时加入，无须选择。**

## 1. 确认 Michi 安装版本

默认安装器将代码、依赖和构建产物放在 `~/.michi`，macOS 桌面 App 安装在
`~/Applications/michi.app`。安装器已经完成构建；普通用户无需另建开发工作树。
在终端检查：

```sh
cd "$HOME/.michi"
node --version
kirocrew --version
node -p 'require("./backend/src/agents/crew/app/app.json").version'
ls backend/scripts/crew-setup.cjs \
   backend/src/agents/crew/app/app.json \
   backend/dist/crewAcp.js \
   backend/dist/crewMcp.js
```

Node.js 需要 **22.19 或更新版本**。如使用自定义安装目录，请将本文的
`~/.michi` 替换为实际安装目录；setup 脚本根据自身位置生成路径。
本教程需要包含完整 setup 脚本的 Michi 版本，随包 Crew App manifest 应为 **0.5.0 或更新**。

如果文件或 Crew Runtime 不存在，使用正常的更新入口，升级到包含 Crew 支持的版本：

```sh
michi update
```

macOS 更新会退出并替换桌面 App，完成后重新打开。开发目录里的改动不会自动更新
安装版；尚未发布的本地提交也无法通过安装器获得。

## 2. 准备 Michi App

先启动官方 KiroCrew，默认 Gateway 为 `http://127.0.0.1:5476`。
Michi 通过名为 `michi-crew-runtime` 的 App 接入。

在 **Michi 安装目录**执行：

```sh
cd "$HOME/.michi"
node backend/scripts/crew-setup.cjs
```

脚本默认同时加入 **Michi MCP 和 Approvals**，不需要选功能或加开关。
命令会打印 `Prepared App: /…/michi-crew-app-…`。下一步使用这个实际目录。
脚本准备 App 文件，安装、启用和权限授权由官方 Crew 流程记录。
准备目录是临时目录，请及时使用。更新 Michi 后重新运行脚本，从新目录更新 App，保留
已有 App secret 和会话。

如果 Michi 设置了 `MICHI_ENABLED_RUNTIMES`，列表中需要包含 `crew`。
默认没有设置这个变量时，不需要额外配置。

## 3. 在 KiroCrew 完成一次性配置

本节步骤全部必需。这些是后端接入操作；完成后，日常聊天和审批都在 Michi 中进行。

### 安装或更新 App，并授予审批权限

1. 打开 Crew 的 **Apps** 页面，安装脚本打印的目录。
   已存在 **michi-crew-runtime** 时，使用官方 **Update / Sync** 更新，保留 secret 和会话。
2. 查看并同意 **sessionApproval** 权限。更新后 App 可能暂时禁用，需先完成授权。
3. 确认 App 显示 **Enabled**。

**sessionApproval** 是一次性接入授权，让 Michi 能接收和答复 Crew 的原生审批请求。
日常的 **Ask / Trust** 模式在 Michi 选择；授予接入权限本身不代表自动批准所有工具。

`sessionApproval` 是官方的较广权限，也覆盖用户自己创建的 Crew 会话。
Michi 的适配器只处理自己所属的本机、未链接 App 会话。通过 Michi 控制这些对话，
避免同时从 Crew 控制同一对话。

### 开启并批准 Michi MCP

1. 打开 **Developer → MCP Management**，找到 `michi-crew-runtime:michi`。
2. 检查 Node 启动命令，开启 **Stub / Routed**，批准启动。
3. 核对 Node 参数应是下列路径展开后的绝对路径：

```text
~/.michi/backend/dist/crewMcp.js
```

setup 脚本自动生成安装目录中的绝对路径，并记录运行脚本使用的 Node 可执行文件。
自定义安装目录应使用该目录下的 relay。之后保持这份安装和 Node 路径可用。

### 重启 Gateway

等 Crew 当前任务结束或手动停止后，执行：

```sh
kirocrew restart --port 5476
```

Agent Capabilities 的 **Apply & Restart** 重启聊天 Agent；这里需要重启 **Gateway**，
让新 Stub 和模板的 broker 路由生效。如更改过 Gateway 端口，请使用实际端口。

缺少必需的授权或 MCP 配置时，Michi 会显示 **Crew setup required** 或接入未完成错误，
并阻止新任务。补齐本节配置后回到 Michi 重试。

## 4. 在 Michi 中使用

macOS 正常打开桌面 App，或运行 `michi`。Linux 运行 `michi start`，访问打印的
地址；默认是 `http://localhost:4649`。

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
| MCP 仍走旧代码 | 从实际安装目录重新运行 setup 脚本，用生成目录更新 App，核对 Node 参数中的绝对路径。 |
| Ask 不弹审批卡 | 确认 sessionApproval 已同意且 App Enabled；查看 Crew allowlist / 全局 YOLO 是否先自动批准；检查全局权限设置。 |
| 修改 Memory 后旧对话没有变化 | 已有会话模式固定；改默认值后新建对话。 |
| 响应慢 | 查看是否选了 Extra high / Max、排队或等待审批；先用短消息和 Medium / High 排查。 |
| 开发重启后本轮中断 | watcher 重启会终止适配器；确认原生任务已经停止，再恢复或重试。 |
| 桌面 App 仍是旧版 | 使用正常安装更新流程；只修改代码目录或构建 backend 不会更新桌面包。 |

改进程环境变量后重启 Michi backend。常用覆盖项：
`CREW_GATEWAY_URL`（默认 `http://127.0.0.1:5476`）、
`KIROCREW_HOME`（默认 `~/.kiro/crew`）、
`MICHI_CREW_MCP_DIR`（默认 `~/.michi/crew-mcp`，Michi 与 relay 必须一致）。
不需要把 App secret 复制进提示词、教程或环境文件。

## 8. 当前边界与验证范围

已接入文字 / thinking、原生工具输入输出、模型 / reasoning / 模板、恢复、稳定历史
fork、Memory、Michi MCP 和 Michi 内审批。

官方 App 调用者目前**不支持同轮 steer**；忙时发送的消息进入下一轮队列。
Crew 自动 compact 可用，但没有 Michi 手动 compact 命令。
没有独立的 Crew 子 Agent 管理界面，适配器未接入图片 / 音频。
私有 Member 的 Memory 继承还没有真实验收。

历史真实 Gateway 验收在 **2026-10-07 / 0.8.0-insider.14** 完成，涵盖 Memory、
恢复 / fork、MCP 隔离和 Allow Once / Deny。Trust 两项由受控自动化测试验证。
2026-10-12 本机 CLI 为 **0.8.0-insider.16**；这次 dev 整合的自动测试和构建结果
见 [VALIDATION.md](VALIDATION.md)，不等同于对 .16 重跑完整真实验收。

更详细的运行原理见 [Runtime README](README.md)，审批语义见 [APPROVALS.md](APPROVALS.md)。
