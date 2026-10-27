# Michi approval choices

普通对话在 **Ask** 下出现审批卡，按钮统一为：

| 按钮 | 作用和范围 |
| --- | --- |
| **Deny** | 拒绝这一次工具请求。 |
| **Allow Once** | 只批准这一次请求；下一次仍按当前审批策略处理。 |
| **Trust this tool** | 在当前对话中信任这个工具；其他工具和其他对话仍保持原策略。授权保存在 Michi，选择 Ask 可以清除。 |
| **Trust all tools for this session** | 当前存活的 Runtime 会话中自动批准所有工具请求，本轮后续请求和已经排队的请求立即生效。会话重建或后端重启后失效。 |

卡片上的两种 Trust 不改变全局 Ask / Trust / YOLO 默认值，不解除原生
Runtime 的 sandbox、工具 allowlist 或治理限制。Settings 里的全局 Ask
即使已开启，也允许对当前请求选择上述有限范围的信任。

想撤销：全局权限开启时，在 **Settings → Model → Permissions** 重新选择
**Ask**；全局权限关闭时，在当前对话 composer 中重新选择 **Ask**。
前者清除该用户所有对话的工具授权和临时会话信任；后者只清除当前对话。
工具信任可以跨该对话的恢复保留，临时会话信任不会写入数据库。分叉对话
没有继承这些授权。

推荐日常保持 **Ask**，遇到一次操作点 **Allow Once**；持续使用同一个工具
时点 **Trust this tool**；想让当前会话自行完成一整段任务时再选最后一项。
审批卡不绑定快捷键。可以点击按钮，也可以用 Tab 选中按钮后按 Enter 或 Space。

Kiro CLI 和 KiroCrew 都通过 Michi 逐次答复原生 `allow_once`，Claude 和
Codex 也保留单次原生批准，Pi 在工具执行前检查。原生的持久 trust 不被
启用，因此 Michi 可以撤销授权。Crew 的稳定 `tool_name` 和展示标题分开
处理；如果某个 ACP Runtime 只给出描述性标题、没有稳定工具身份，
**Trust this tool** 会禁用，其他可用选项仍可使用。Executor Agent Run
继续遵循其独立的 Run/Attempt 审批策略。
