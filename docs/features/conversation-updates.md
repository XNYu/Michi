# Conversation increments

Native Pages integration reviewed against `feat/pages-spaces` source on 2026-10-26.

Michi reads newly completed conversation turns directly from `turns` and
`messages`. It does not maintain a separate change log or copy message bodies.

## Storage and ordering

Migration `0033_conversation_completion_seq` adds `turns.completion_seq`,
`scheduled_jobs.conversation_cursor` and a partial index on
`turns(node_id, completion_seq)`. Each workspace has one mutable `meta` value,
`conversation_completion_seq:<workspaceId>`, initially zero when absent.

The shared main-thread/worker finalization transaction writes the final
messages, node projection, counter and completion sequence together. Only a
first successful finalization with a user message receives a sequence.
Scheduled inputs carry server-generated `metadata.scheduledJobId`, so their
answers are excluded even though the job's prompt remains visible as a user
message. Failed, cancelled and interrupted turns are excluded. Repeated
finalization does not allocate another number; rollback also rolls back the
counter. Completion time is not the ordering key.

Existing turns are not backfilled. Cross-workspace tree moves clear the moved
turns' sequences without reducing either workspace counter. Same-workspace
moves preserve them. Deleted/archived/unreadable inputs can leave holes, so
counts query actual rows rather than subtracting cursor values.

## Read API

`GET /api/workspaces/:workspaceId/conversation-updates?after=0`

The `read_conversation_updates` tool exposes the same service to Pi and the
MCP-backed runtimes. The tool's workspace and owner come from its session;
the HTTP route uses authenticated ownership. Both check the workspace's AI
navigation permission. Agent Run callers also retain their Read and message
context policy checks. The query includes only readable, unarchived chat
nodes in the named workspace.

Arguments:

| Argument | Meaning |
| --- | --- |
| `after` | Required nonnegative safe integer; exclusive lower bound |
| `through` | Optional inclusive upper bound; defaults to the current workspace counter |
| `limit` | 1–100 turns, default 20 |
| `includeMessages` | Boolean, default false |

The result contains `after`, `through`, `totalTurns`, `byNode`, `turns`,
`nextAfter` and `hasMore`. Counts describe all currently readable rows in
`(after, through]`, not just the returned page. Each turn includes its sequence,
turn/node/tree IDs, source message IDs, completion time and a stored-text
preview. No model is invoked to produce previews.

Keep the first response's `through` when paging. Newly completed turns receive
larger sequences and belong to the next batch. This bounds a sequence interval,
not a long-lived snapshot of permissions or message contents. Each request
checks current access and existence again, with one short read transaction
covering authorization, counter, statistics and page contents.

Set `includeMessages=true` to read the initial user input, accepted steering
inputs and final assistant reply. Thinking blocks and tool details are omitted.
Messages retain stable IDs. User metadata is limited to `steered`,
`quotedText`, `comments` and `attachments`; other user metadata and all
assistant metadata are omitted. Full message bodies are
limited to 64 KiB of serialized message data per response; envelope/statistics
are additional. A page ends before a turn that cannot fit. If the first turn
is oversized or its source boundaries are unavailable, its descriptor has
`contentTooLarge` or `contentUnavailable`, no messages, and `nextAfter` stays at
`after`. Never mark that entry consumed. Existing `read_pane_output` can page
an assistant answer; message-count pagination does not split a giant user input.

`nextAfter` is the last fully delivered turn when more remain, or `through`
when exhausted (including an empty result). Save it only after processing the
returned inputs. A future/reset cursor returns `cursor_invalid`; malformed
arguments return `invalid_argument`. Historical edits, deletions, imports,
restored archives and moved history are not new completion inputs.

## Scheduled consumption

An internal caller can set `conversationUpdates: true` on the existing
scheduled-job create/update API. This generic consumer uses the existing
scheduler. The server initializes progress to the current workspace counter, starting from
now. Disabling sets the cursor to null; re-enabling or changing workspace
starts from that workspace's current counter. Pausing/resuming an already
enabled consumer preserves its cursor. Consumer scope cannot change during a run.

Before opening a runtime/session, the scheduler reads at most one bounded page.
An empty page completes quietly, with no model or notification; an oversized,
unavailable or unauthorized input fails without consuming it. Ordinary jobs
retain their existing execution path.

The generic integration supports **explicit no-change decisions**. A scheduled
turn receives the complete batch plus an ephemeral batch token. It calls
`report_conversation_no_change` with that token, source turn IDs and a reason
for turns needing no page change. The tool confirms only members of that
workspace's active batch; the model cannot supply a cursor. All delivered
turns must be confirmed. Prose, partial confirmation and a successful chat
alone do not count. The token is discarded when the turn settles or is cancelled.

Cursor advancement and terminal run state commit together, using compare-and-set
against the original cursor, workspace, active run, scheduler owner and unexpired
lease. Failed, cancelled, timed-out, interrupted or attention-requiring runs
retain progress. A retry can read the same inputs again. This is at-least-once
reading, not exactly-once model execution.

Generic consumers still cannot confirm Page writes or proposals. Jobs in this
mode leave inputs requiring changes unconfirmed and explain the pending work.
They fail with progress retained rather than treating a claimed write as success.

## Native Pages maintenance

Native Pages adds a managed consumer to the same scheduler. Its configuration
is owned by a workspace and exposed through Pages; it is separate from a
generic `conversationUpdates` job. New pages offer conversation maintenance
during creation through a tree exclusion setting. Once workspace maintenance
is enabled, all undeleted, non-excluded page trees are eligible, including
existing ones; this is not a per-page enrollment allowlist. The backend
can process new completions with all Page and Helper panes closed. It must remain
running, and the selected runtime and provider must remain available.

The scheduler binds a durable processing plan to the job, run, lease and
configuration revision. Each source turn has a complete eligible resource
manifest and an inspectable routing decision. The restricted tools page through
original messages, Pages and databases; each routed resource ends with a
verified write/proposal receipt or an explicit no-change decision. The model
cannot advance the completion cursor by claiming success in prose.

The native writer keys a resource operation by job, source turn, resource kind,
resource ID and processing generation. It commits the resource's operation set
and receipt atomically. Retries reuse the saved receipt and stable allocated
IDs; a different payload for an already committed key is a conflict. Stale
targets or authority retain unresolved progress. Human-owned content continues
to require proposals, and changes retain the original conversation evidence
separately from the scheduled execution.

The managed profile uses Settings → Meta agent and supports Pi, Claude,
Codex and Kiro. Each adapter checks its actual exposed tool catalog against
the restricted allowlist at session startup. Crew remains unsupported for
the Meta agent, independently of its ordinary chat Page tools. The current
Pages/Meta agent UI is local-only; remote workspaces are not enrolled/read
through it. Enabling maintenance does not grant shell, arbitrary
network, job-management, component-library or proposal-acceptance permissions.

Pause retains progress. Excluding a root page tree records its excluded
completion interval; re-enrollment requires an explicit bounded catch-up to
reconsider that interval. Status, pending work, reconsideration and the managed
job's run history remain visible in Pages. This is eventual model-driven maintenance;
a terminal plan records completed decisions without guaranteeing perfect
relevance judgments or user acceptance of proposals.

Home initialization is a separate bounded read of existing workspace
conversations. Workspace-home change provenance may cite user or assistant messages
actually returned by `read_node`; Markdown `segmentSources` require exact
assistant-message identities. The global Pages Home summary reads workspace homes rather
than raw conversations and cannot attach invented conversation evidence.
Both use the target page's own layout preferences and existing rules.

The maintenance/Home planner may commit permitted edits and protected
proposals together when every operation plans successfully. Ordinary atomic
chat `edit_page` rejects such mixed groups; these are distinct writers.
See the source-reviewed [Pages maintenance guide](../../backend/src/docs/pages-maintenance.md).

These are implementation contracts. Real provider/browser acceptance and any
remaining failures are recorded separately in the Pages task evidence.

## Backup

A full local database backup must preserve the workspace counters, turn sequences
and job cursors together. Portable conversation backups omit complete turns,
these counters and scheduled jobs, so imported messages do not masquerade as
new completions or resume an unrelated consumer cursor.
