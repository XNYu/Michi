# Response time, context and usage

Applies to: ordinary chats; provider metrics vary by runtime/model. Source checked: 2026-10-16. No latency target, price or billing equivalence is implied.

## Why is a response taking so long?

Before adjusting a prompt, identify the phase:

| Phase | Evidence | Useful action |
| --- | --- | --- |
| Session startup/authentication | No model activity; runtime/setup errors | Check runtime availability, credentials and logs |
| Model reasoning | Thinking output or provider activity | Compare a lower supported reasoning level on a small task |
| Long context processing | Large history, repeated instructions or attachments | Supply relevant sections; use targeted retrieval |
| Tool execution | Active command/network/tool call | Inspect that operation's output and duration |
| Waiting for permission/input | Approval or question card | Answer it |
| Queue or capacity | Queued message, concurrency/capacity error | Inspect current work; avoid duplicate sends |
| Connection loss | Disconnected stream/backend | Reconnect to the original chat first |

A slow tool, a long reasoning phase and a lost stream require different fixes. Moving instructions between prompt roles does not resolve all of them.

## Make a useful comparison

1. Keep the same backend, Runtime and model.
2. Start a small fresh test chat so that a long existing history does not dominate.
3. Use a lower supported reasoning level where appropriate.
4. Measure time to first useful output and total completion, including tool/approval waits.
5. Compare output quality as well as time; do not replace a complex task's evidence with a trivial benchmark.

Success check: the specific phase becomes faster without losing the needed result. A single fast response does not establish a provider-wide performance guarantee.

## Should fixed instructions move into a template/system prompt?

Stable role, project conventions and output rules belong in the appropriate instructions/template. The current task and changing evidence belong in turn input or retrievable sources. Crew's default `michi-crew` template already carries fixed integration instructions.

Avoid repeating a full manual on every user turn. Keep concise standing guidance and retrieve detailed documents when needed. `michi_docs` is designed for on-demand reads rather than full-manual injection.

System-role content still consumes context; role alone does not make it free or guarantee lower latency. Provider prompt caching, context reuse and reasoning behavior vary. Measure the installed Runtime instead of promising a specific speedup.

Custom templates must preserve Michi's tool configuration and output conventions. A shorter template that removes integration requirements can make tools or UI behavior fail. See `crew` and `custom-agents`.

## Manage long conversations

Reference relevant Artifacts and ask for original passages when details matter. An Artifact manifest or chat summary is not a full read. Use a fresh branch when exploring a separate direction, but remember that inherited context can still be large.

Manual compaction is connected for appropriate Kiro CLI/Codex sessions. Crew manages automatic compaction and has no Michi manual compact command. Pi and Claude do not expose that command through the current integration. Compaction is a summary mechanism, not a backup or guaranteed exact retention of every detail.

Before a long handoff, save the current goal, verified state, files, decisions and unresolved questions as an Artifact. Keep sources so the next agent can refresh facts.

## Tokens, credits and money

| Signal | What it means | What it does not establish |
| --- | --- | --- |
| Runtime token usage | Usage fields emitted by that engine/provider | A complete invoice or equal reporting across runtimes |
| Context usage | Estimate/report of occupied model context where supported | Total accumulated billable usage |
| Provider credits/quotas | Provider-side entitlement/limits | A universal Michi balance |
| Supplier invoice/account usage | Provider's billing record | Something Michi can infer exactly from every transcript |

Do not add cumulative snapshots as if each were a new increment. Do not invent a token count, price or cost when the runtime did not provide it. Check the actual provider account for billing, model access and current prices.

Related documents: `troubleshooting`, `concepts-and-context`, `configuration`, `runtime-capabilities`, `privacy-and-data`.
