# Task states, queued messages and session recovery

Applies to: ordinary desktop/web chats, including remote workspaces. Agent Runs use the lifecycle in `custom-agents`. Source checked: 2026-10-16; native behavior depends on installed runtimes.

## Is the task working or stuck?

| Observation | Possible meaning | First action |
| --- | --- | --- |
| Thinking/reasoning | Model is working | Check reasoning level and progress |
| Active tool call | Command, network request or tool running | Inspect that call's output/duration |
| Approval card | Permission decision needed | Review and answer it |
| Ask User card | Information needed | Answer the question; Trust does not answer it for you |
| Queued message | Input awaits a boundary or later turn | Check the queue before sending a copy |
| Disconnected view | Lost backend/stream connection | Reopen the same chat; check the connection |
| Complete-looking answer, briefly busy send | Runtime still owns/cleans up the turn | Allow normal cleanup |

A spinner alone does not identify the cause. Inspect recent activity and relevant logs before cancelling or restarting.

## Send while an agent is working

The composer follows current session capabilities.

| Runtime | Busy input |
| --- | --- |
| Kiro CLI | Steering at a supported agent boundary; engine/version matters |
| Pi | Steering at the next assistant-turn boundary |
| Codex | Native `turn/steer` |
| Claude | Queues for the next Michi turn; no integrated same-turn steer |
| Crew | Queues for the next turn; official App callers cannot same-turn steer |

Steering does not instantly roll back an executing command. If execution must stop, use Stop, inspect actual effects, then send the corrected request. Queueing and steering do not undo prior effects.

## Stop, close, refresh and quit

| Action | Effect |
| --- | --- |
| Stop a chat | Requests targeted cancellation; prior file/external changes remain |
| Close a pane | Closes the view; does not delete history or request cancellation |
| Refresh/reload | Detaches subscriptions, then rehydrates/reconnects |
| Close a desktop window | Does not itself send cancellation; process lifetime depends on platform/app |
| Quit local app/backend | A stopped backend cannot continue local execution; saved history remains |
| Quit desktop using a remote workspace | Stops local connections/tunnels, not the remote backend/turns |
| Restart a backend | Interrupts running processes; durable records support recovery, not uninterrupted work |

Cancellation may take time while output drains. Stop is not proof of external rollback. Check actual resources before repeating consequential actions.

## Reconnect without duplicating work

1. Return to the original backend, workspace and chat.
2. Restore connectivity and let history/activity load.
3. Determine whether the original turn is active, completed, cancelled or failed.
4. Continue once its state is known; check effects before repeating an action.

A stream HTTP 410 means that stream cannot be used. It does not prove provider failure or lost history. A `409` with code `turn_active` identifies a busy durable turn; Michi handles its supported retry internally. Other conflicts and ambiguous failures do not justify blind resending.

If unclear, collect timestamp, runtime, visible status and a small adjacent log excerpt. Preserve the chat rather than deleting it to force a binding.

## Native Resume and Native Fork

Settings → Model shows these switches for runtimes that expose them. They are per runtime and independent.

Native Resume restores provider-side state when available. Disabling it changes cold-session reconstruction and does not interrupt live sessions. Text reconstruction uses persisted conversation material; hidden native state and every original tool result may not be restored.

Native Fork creates a child from compatible native history. Parents generally must be idle and match runtime/workspace/owner constraints. A fork cut at an earlier message is exact when the runtime supports that anchor (for example Kiro rewind); otherwise Michi falls back to a textual transcript that stops at the selected branch point, not at the parent's latest state. Missing or unsupported history uses textual context; ambiguous runtime failures can surface instead of silently starting over.

Crew forks copy Gateway transcripts into independent sessions and inherit Memory identity/mode; they are not Kiro CLI checkpoint clones. Pi uses context-based branching.

JSON backup imports deliberately clear live native bindings. See `data-and-backups`.

## Edit/resend and file changes

Editing and resending a previous message changes the conversation path. It does not rewind files. Inspect current files/diffs and use Git or another explicit recovery mechanism for rollback.

Success check: the intended chat is open, its backend/folder are correct, the original task's state is understood, and a follow-up succeeds without duplicate changes.

Related documents: `troubleshooting`, `permissions`, `runtime-capabilities`, `data-and-backups`, `remote-backend`.
