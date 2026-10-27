# Pages automatic updates and the Meta agent

Applies to: native Pages and the local Meta agent in this backend source. Source checked: 2026-10-26. Runtime support below is a source contract, not live provider or installed-app acceptance. See `pages-and-components` for editing and `page-component-design` for component styling.

## Three kinds of work

| Path | What it reads | What it changes |
| --- | --- | --- |
| Pages Assistant | Accessible Michi work requested in the conversation, using its restricted chat tools | Requested pages/rows; protected content becomes a suggestion; new ordinary conversations require the start-conversation approval flow |
| Initial workspace-home generation | Eligible conversations in that workspace within the configured initial look-back | Only its assigned workspace home, citing messages actually read |
| Automatic conversation maintenance | Newly completed, readable conversation turns in an enrolled workspace | Eligible pages/databases through verified write/proposal receipts, or explicit no-change decisions |

Pages Home also has a separate summary pass. It reads workspace home pages, not their original conversations, and writes only its assigned Home. It removes conversation-source claims from those summary writes rather than pretending it read the underlying messages. Home's computed Waiting/Stalled/Done sections and progress cards are separate from a durable task database: a completed reply/run does not by itself mean a business task is done.

## Runtime and scope

The Pages Assistant, initial generation and maintenance use the shared configuration in **Settings → Meta agent**. Pi, Claude, Codex and Kiro are approved for this restricted profile. **Kiro Crew is not supported for the Meta agent**; that does not remove Crew's ordinary chat capability. Every session must pass its adapter's actual tool-catalog check; an unsupported or unexpectedly broad catalog fails with a restriction error instead of silently running with more permissions.

The profile restricts tools and data access. It does not become a general coding session when the ordinary chat permission mode is Trust/YOLO. Maintenance cannot use arbitrary shell/network, manage jobs, save component-library code or accept its own proposals. The Assistant has a separate allowed chat catalog, including documentation and native Page/component tools. Tool availability for an ordinary chat or Agent Run does not imply availability in maintenance.

The current Pages/Meta agent UI is local-only. Remote workspaces are displayed unavailable and are not queued or read by this interface. Processing requires the backend, scheduler, selected runtime and provider to be available. Closing the Page or Assistant pane does not stop backend maintenance; stopping its backend does. A configured background service can keep a supported packaged backend running after the app closes; see `configuration`.

## Enable, pause and catch up

Use a page's **Conversation maintenance** panel. Maintenance is enabled for a workspace and considers all its undeleted page trees except those explicitly excluded. New-page creation offers **Keep up to date from this workspace’s conversations**, which controls the new tree's exclusion. Check existing trees' exclusion settings when enabling workspace maintenance; the current checkbox helper text about existing pages is not an enrollment allowlist. The panel links to **Change in Settings › Meta agent**, rather than owning a separate runtime profile. It exposes status, pause/resume/run controls and **Open job** for the managed scheduler job.

Enabling incremental maintenance starts at the current completion position. It does not silently scan all historical conversations. The explicit initial-home read and its configured look-back are a separate path. Native maintenance pause, disable and re-enable preserve its saved cursor. Generic `conversationUpdates` consumers have separate cursor-reset rules when toggled; do not apply those rules to the native managed configuration.

Page-tree exclusion records the completion interval it missed. Re-enabling makes the page eligible for new work but does not revisit earlier inputs. Use **Queue this period** for an offered, bounded catch-up of a recorded exclusion period; it is limited to that root page and its current children. **Reconsider** requests another decision for an unfinished/disputed source. It is not permission to repeat arbitrary external actions.

| Status | Meaning |
| --- | --- |
| Not enabled / Paused | Automatic processing is not active; inspect configuration before expecting new results |
| Updating / new turns waiting | Work is running or queued; processing is eventual, not tied to a fixed UI latency |
| Needs attention | A source/resource decision remains unresolved; inspect it and use Reconsider where appropriate |
| Last update failed / Status unavailable | Inspect the recorded error or restore connectivity; a missing status is not proof of completion |
| Up to date | Available inputs have durable decisions; suggestions can still await review, and model relevance judgments can be wrong |

Saving **Layout preferences** alone does not enqueue a model turn or rearrange content. Each maintenance/initial-generation read uses the target page's own preferences and rules; global Home preferences do not propagate to workspace or child pages. Program-applied section limits remain authoritative.

## Evidence, ownership and progress

Only eligible successful completed conversation turns enter the completion feed. Failed/cancelled/interrupted turns and scheduled inputs do not become new ordinary conversation inputs. Existing history is not backfilled just because this feature is enabled. Edits, restores and imports do not impersonate fresh completions.

The reader uses a bounded completion interval and retrieves original source messages. Empty checks do not invoke a model. Unreadable or oversized inputs remain unresolved instead of being counted as processed. A durable processing plan records eligible resources and routing decisions. Every routed resource needs a verified applied/proposed receipt or explicit no-change decision before its source is considered complete. Routing is final: a routed source can never gain resources. When a run is recovered after routing, `maintenance_list_resources` returns the routed resources with each one's decision and changes nothing. Reading a routed resource again from its first page (offset 0, no cursor) refreshes its revision to the current one; a continuation read cannot. The agent therefore reads again and then writes or records no change from what it read, which also recovers a write refused because its target changed. Writes keep their per-row and per-block revision checks, and a decision that is already recorded is never repeated. A routed resource that was deleted or excluded, or whose page route changed, is skipped with a reason when it is read, so the plan can still finish; the workspace task database instead adopts the new board route, since its tasks belong to the workspace.

The native writer commits an operation set and its receipt together. Retry identity includes the job, source turn, resource and processing generation. An identical committed payload reuses its receipt; a different payload for that key conflicts. Stale revisions, lost authority or incomplete resource decisions retain progress for inspection. A successful chat response or a prose claim of “done” cannot advance the cursor by itself.

Human-edited fields/blocks retain protection. Unlike atomic `edit_page` groups from chat, the maintenance/Home planner may persist permitted edits and protected proposals in the same transaction when all operations plan successfully. A stored proposal is a completed processing decision, not a user acceptance or an applied content change. Do not transfer the chat tool's mixed-group rejection rule to this separate writer.

New Markdown `segmentSources` must use verified evidence. Initial workspace generation may cite only assistant messages returned by its reads. Incremental maintenance may add its acknowledged source and retain existing page evidence. The writer validates message identity and workspace/owner scope before saving. Whole-block change provenance and per-item evidence serve different purposes and are not interchangeable.

## The task database

A workspace's task database (see **Tasks** in `pages-and-components`) is always among the resources maintenance considers for a new completed turn: whether or not a page shows its board, and even when the page tree that shows it is excluded. **Queue this period** does not read it again, because ordinary maintenance already handled those turns.

Once the task database is routed for a source, maintenance finds tasks with `maintenance_list_tasks`: by `nodeId` (the tasks that link that conversation), by words in a task, its next step or its notes (`query`), and by `statuses`. It returns at most 20 compact tasks, newest change first, with their row id and `rev`, who set the status (`statusSetBy`), the conversations waiting on the user now, and `goneConversationIds`: linked conversations deleted or moved to another workspace. `more` says there are others; narrow the search. Maintenance writes tasks with `maintenance_write_database`, following the Tasks rules of `pages-and-components`:

- Update the tasks that link the turn's conversation, link the conversation to a task it works on, and add a task only for a goal no task covers; never add one task per conversation.
- A finished turn does not make a task done. Mark a task Done only with evidence that its goal is reached.
- A cell the user edited is theirs, including a status set by dragging a card: a write to it becomes a suggestion the user accepts or dismisses.
- Unlink the `goneConversationIds` of a task you update.
- Do not route the task database for a turn that works on no goal.

On the workspace's board the cards an update added or changed read **New** or **Updated**, its suggestions wait on their cards, and a line above the board says what it did, with Undo while any of it was written. Undo puts back the whole update, including a suggestion from it the person already accepted. All tasks shows none of these marks.

## Diagnose an update that seems missing

1. Check that the workspace is local, workspace maintenance is enabled, the page tree is not excluded and the backend/scheduler is running.
2. Inspect the Meta agent runtime/model and any restriction or provider error; changing ordinary chat permissions does not fix an unavailable profile.
3. Check whether the source was a new eligible completed turn, part of an explicit initial read, or requires a catch-up period.
4. Check page exclusion, **Ignore** protection, pending suggestions, unresolved sources and **Open job** history.
5. Read the saved page/receipt and exact Sources before claiming the content changed. A pending proposal or consumed no-change decision may explain the visible result.

## Storage and backup

Pages, database rows, source/change history, layout-preference revisions, processing plans and cursor state are stored in the backend's SQLite database. Conversation Markdown exports and portable JSON backups do not include the complete native Pages state. Preserve the stopped backend's data directory for a complete backup; see `data-and-backups`.

Generic scheduled jobs with `conversationUpdates: true` are a separate consumer: their explicit no-change confirmations do not grant the native maintenance writer's ability to acknowledge Page writes. Both use the scheduler, but their completion rules differ.

Related documents: `pages-and-components`, `page-component-design`, `configuration`, `data-and-backups`, `runtime-capabilities`, `troubleshooting`.
