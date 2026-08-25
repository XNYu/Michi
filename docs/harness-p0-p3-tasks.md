# Michi Agentic Harness P0–P3 Task Contract

Branch-native research control plane. Conversation graph, panes, digest/merge/map,
follow-ups, branch overview, ChatHub, permission/AskUser presentation, artifacts,
and `spawn_branches` stay first-class. Do not fake token/cost, cancel-settled,
Teams/Tangent, or worktree forks.

Verification log (command + result) is appended as tasks land.

---

## P0 — Contract + honest states

### T-P0-1 Shared CapabilityDescriptor
- **Scope:** `shared/src/harness.ts`, `shared/src/index.ts`
- **内容:** `CapabilityAvailability`, `EventConfidence`, `CapabilitySlot`, `CapabilityDescriptor` (steer, followUp, interruptAck, compact, retry, sessionFork, nativeResume, permissions, sandbox, subagents, usage), helpers `slot()` / `invisibleSlot()`.
- **验收方法:** `cd shared && npx tsc -p tsconfig.json --noEmit`; backend unit test imports helpers and asserts slot shape.
- **Expectation:** Shared package exports the descriptor types. No runtime behavior yet.
- **Depends on:** none

### T-P0-2 Descriptors on all 7 runtimes + status API
- **Scope:** `backend/src/agents/capabilityDescriptors.ts`, each `*Runtime.ts`, `backend/src/agents/types.ts`, `backend/src/routes/agent.ts`, frontend `AgentStatus`
- **内容:** Every runtime advertises a descriptor. Booleans stay for back-compat. `/agent/status` includes `capabilityDescriptor`.
- **验收方法:** `cd backend && npm test -- --test-name-pattern 'capabilityDescriptor'`
- **Expectation:** Pi/Codex/Claude/Kiro/Cursor/Grok/Antigravity each have honest slots (Claude/Antigravity steer=`invisible`; Codex/Pi steer starts `native_unwired` until wired).
- **Depends on:** T-P0-1

### T-P0-3 HEP v2 events added (not replaced)
- **Scope:** `shared/src/chatStreamEvents.ts`, `backend/src/services/chatEvents.ts`, `backend/src/routes/chatStreamEvents.ts`, frontend `dispatchChatStreamEvent`
- **内容:** Add `cancel_phase`, `queue_update`, `steer_accepted`, `compaction_start/end`, `retry_start/end`, `harness_lifecycle`. Envelope may carry `source`/`confidence`/`nativeMethod`. Old events remain valid.
- **验收方法:** backend `chatStreamEvents.test.ts` + frontend `chatStreamEvents.test.ts`
- **Expectation:** Old SSE clients parse existing events. New events parse. Unknown clients ignore new names.
- **Depends on:** T-P0-1

### T-P0-4 harness_events journal + ChatHub provenance
- **Scope:** `backend/src/db/migrations/0017_harness_events.sql`, `backend/src/services/harnessJournal.ts`, `backend/src/agents/chatHub.ts`
- **内容:** Append-only journal. ChatHub `stamp()` writes source/confidence. 60s ring unchanged. ChatHub remains the only runner.
- **验收方法:** `cd backend && npm test -- --test-name-pattern 'harnessJournal|ChatHub provenance'`
- **Expectation:** Each appended frame is journaled by `(nodeId, turnId, seq)`. Snapshot projection still works if journal write fails.
- **Depends on:** T-P0-3

### T-P0-5 Cancel three-phase
- **Scope:** `backend/src/agents/chatHub.ts`, `backend/src/agents/types.ts`
- **内容:** `requested` → `acknowledged` (runtime ack) → `settled` (terminal done/error). Never mark settled on disconnect alone.
- **验收方法:** `cd backend && npm test -- --test-name-pattern 'cancel phase'`
- **Expectation:** Stop before POST refuses start. Stop after start emits requested. Ack only when `cancel()` reports acknowledged. Settled only on terminal frame.
- **Depends on:** T-P0-3, T-P0-4

### T-P0-6 Honest UI: badges, unverifiable usage, cancel-requested
- **Scope:** frontend capability badge, TPane/composer status, usage rendering, reducers
- **内容:** Render availability badges. Usage without native source shows `unverifiable`. Cancel shows requested/acknowledged until settled.
- **验收方法:** frontend vitest for helpers + reducers + composer copy
- **Expectation:** Invisible capabilities are not drawn as supported. Cancel does not flip to idle until settled.
- **Depends on:** T-P0-2, T-P0-5

---

## P1 — Wire existing high-fidelity surfaces

### T-P1-1 Optional AgentSession control methods
- **Scope:** `backend/src/agents/types.ts`, `backend/src/agents/chatHub.ts`
- **内容:** Optional `steer` / `followUp` / `clearQueue` / `compact` / `describeNativeState`. ChatHub calls only when present.
- **验收方法:** ChatHub unit tests with mock session that has/lacks methods
- **Expectation:** Missing methods leave current behavior unchanged and return `invisible`.
- **Depends on:** T-P0-2

### T-P1-2 Codex turn/steer, fork align, compact, turn status
- **Scope:** `CodexSession.ts`, `codexEventTranslator.ts`, `CodexRuntime.ts`
- **内容:** Wire `turn/steer`, `thread/fork` (align native id only), `thread/compact/start` (compacting chip), `turn/completed.status`. review/collab stay `experimental`/`invisible`.
- **验收方法:** `codexEventTranslator` + Codex session unit tests
- **Expectation:** Steer RPC is issued. Fork does not create a Michi node. Compact emits HEP compaction events. Interrupted status maps to cancel settled.
- **Depends on:** T-P1-1, T-P0-3

### T-P1-3 Pi event honesty on agent-core
- **Scope:** `backend/src/agents/pi/eventMapper.ts`
- **内容:** Map `turn_start`/`turn_end` → `harness_lifecycle`, `tool_execution_update` → `tool_call_update`. Do not treat Pi `turn_end` as ChatHub `done`.
- **验收方法:** `cd backend && npm test -- --test-name-pattern 'eventMapper'`
- **Expectation:** Tool stdout updates chips. `agent_end` still closes the Michi turn.
- **Depends on:** T-P0-3

### T-P1-4 Frontend queue fork
- **Scope:** `TPane.tsx`, `PaneComposerActions.tsx`, `chatStore.tsx`, `shouldSteerInsteadOfQueue.ts`
- **内容:** `steer=native` → ChatHub steer API. Otherwise keep `pendingQueued` next-turn flush. Copy distinguishes inject-this-turn vs send-next.
- **验收方法:** frontend unit tests for `shouldSteerInsteadOfQueue` + composer aria-label
- **Expectation:** Codex/Pi (after native) steer; Claude still queues.
- **Depends on:** T-P1-1, T-P1-2, T-P0-6

### T-P1-5 Permission source labels
- **Scope:** `chatEvents.ts`, adapters, `PermissionBanner.tsx`, `permissionPolicy.ts`
- **内容:** `michi_policy` / `codex_approval` / `claude_prompt_tool` / `acp_permission` on permission cards.
- **验收方法:** backend permission mapping tests + frontend banner test
- **Expectation:** Source is visible. Workspace grant never auto-approves Codex sandbox-escape.
- **Depends on:** T-P0-3

---

## P2 — Pi Native Engine v1

### T-P2-1 pi-coding-agent behind `MICHI_PI_SESSION_SDK=1`
- **Scope:** `backend/src/agents/pi/PiSdkSession.ts`, `PiRuntime.ts`, `piAi.ts`
- **内容:** Flag on → `createAgentSession` path. Flag off → existing `PiSession`. Preserve preamble, workspace instructions, spawn_branches, artifacts, globalContext.
- **验收方法:** unit tests for factory selection; install `@earendil-works/pi-coding-agent` if published, else prove fallback
- **Expectation:** Default path unchanged. Flag path constructs SDK session or documented fallback.
- **Depends on:** T-P1-3

### T-P2-2 Wire steer / followUp / compact / abort on SDK path
- **Scope:** `PiSdkSession.ts`, ChatHub
- **内容:** Expose SDK methods. Queue follow-up ≠ Michi follow-up chip (new pane).
- **验收方法:** mock-SDK session tests
- **Expectation:** steer/followUp/compact/abort callable only on SDK path; agent-core path stays `native_unwired`.
- **Depends on:** T-P2-1, T-P1-1

### T-P2-3 Pi session tree ≠ Michi tree
- **Scope:** `PiRuntime.ts`, tests
- **内容:** Native fork/navigate never replaces Map/Digest node graph. Child Michi node does not mutate parent Pi leaf.
- **验收方法:** unit test asserting Michi branch does not call `navigateTree` on parent
- **Expectation:** Conversation fork remains a new node. Pi JSONL is resume detail only.
- **Depends on:** T-P2-1

### T-P2-4 Observe compaction / retry
- **Scope:** Pi event mapper / SDK subscribe
- **内容:** Map compaction/retry events when present; otherwise `invisible`.
- **验收方法:** mapper tests for present and absent events
- **Expectation:** No fabricated “already compacted” UI.
- **Depends on:** T-P2-2, T-P0-3

---

## P3 — Claude / ACP fidelity cap + optional SDK spike

### T-P3-1 Claude stream-json fidelity cap
- **Scope:** `ClaudeRuntime.ts` descriptor, Claude session
- **内容:** Descriptor hard-caps: no same-turn steer, no Teams. Keep tool/permission/AskUser/warm pool/resume.
- **验收方法:** descriptor test + existing Claude tests still pass
- **Expectation:** Claude second input still uses `pendingQueued`.
- **Depends on:** T-P0-2, T-P1-4

### T-P3-2 Claude Agent SDK spike (default OFF)
- **Scope:** `backend/src/agents/claude/claudeSdkSpike.ts`
- **内容:** `MICHI_CLAUDE_AGENT_SDK=1` only. Does not replace `ClaudeRuntime`. Documents Teams-unavailable.
- **验收方法:** spike module tests (flag off is no-op; flag on constructs or fallback)
- **Expectation:** Default Claude path unchanged.
- **Depends on:** T-P3-1

### T-P3-3 ACP capability absorption
- **Scope:** `AcpRuntime.ts`, `capabilityDescriptors.ts`, handshake tests
- **内容:** Absorb `loadSession`, image, `_kiro.dev/compaction`, `_session/terminate` into descriptors. Tangent stays experimental/invisible unless probed.
- **验收方法:** existing `acpHandshake.test.ts` locked; new descriptor absorb tests
- **Expectation:** Kiro protocolVersion `"2025-01-01"`, Cursor/Grok `1` unchanged.
- **Depends on:** T-P0-2

### T-P3-4 Antigravity remains black-box
- **Scope:** `AntigravityRuntime.ts`, frontend badges
- **内容:** Honest invisible badges. No steer/compact/permissions chrome.
- **验收方法:** descriptor test
- **Expectation:** Antigravity descriptor has steer/compact/permissions=`invisible`.
- **Depends on:** T-P0-2, T-P0-6

---

## First three slices (former PR1–PR3)

1. T-P0-1 + T-P0-2 + T-P0-6 (partial badges) + T-P0-5
2. T-P0-3 + T-P0-4
3. T-P1-2 + T-P1-4

All work lands on `cursor/harness-p0-p3-d482` as sequential commits.

---

## Blockers

Recorded during implementation if a package/API is unavailable.

| Task | Blocker | Fallback |
|---|---|---|
| T-P2-1 | `@earendil-works/pi-coding-agent` is not installed / not resolvable | `MICHI_PI_SESSION_SDK=1` selects the SDK factory; `tryLoadPiCodingAgent()` returns null and `createPiSession()` falls back to `PiSession` |
| T-P3-2 | `@anthropic-ai/claude-agent-sdk` is not installed | `MICHI_CLAUDE_AGENT_SDK=1` documents the spike; `describeClaudeSdkSpike()` reports `packageLoaded: false` and `replacesClaudeRuntime: false` |

---

## Verification log

### T-P0-1 Shared CapabilityDescriptor
- `cd shared && npx tsc -p tsconfig.json --noEmit` — pass (via `npm run shared:build`)
- `cd backend && node --require ts-node/register --test test/capabilityDescriptors.test.ts` — 6/6 pass

### T-P0-2 Descriptors on all 7 runtimes + status API
- `test/capabilityDescriptors.test.ts` — 7 runtimes, Claude/Antigravity invisible steer, Codex native
- `test/agentStatusRoute.test.ts` — `/agent/status` includes `capabilityDescriptor`

### T-P0-3 HEP v2 events added
- `test/chatStreamEvents.test.ts` — old events + `cancel_phase` / `steer_accepted`
- `cd frontend && npm run test:raw -- src/services/chatStreamEvents.test.ts` — every `CHAT_STREAM_EVENTS` value roundtrips

### T-P0-4 harness_events journal + ChatHub provenance
- `test/harnessJournal.test.ts` — pass
- `test/chatHubHarness.test.ts` “ChatHub provenance” — stamp + journal dual-write; journal throw continues snapshot

### T-P0-5 Cancel three-phase
- `test/chatHubHarness.test.ts` “cancel phase” — requested → acknowledged → settled; no ack when runtime silent; disconnect does not settle

### T-P0-6 Honest UI
- `frontend` `CapabilityBadges.test.ts`, `cancelPhase.test.ts`, `PaneComposerActions.test.tsx` — pass

### T-P1-1 Optional AgentSession methods
- `test/chatHubHarness.test.ts` “ChatHub optional session methods” — missing steer → `{ accepted: false, reason: 'invisible' }`

### T-P1-2 Codex wire
- `test/codexEventTranslator.test.ts` — compaction item + `interrupted`
- `test/codexSession.test.ts` “steer issues turn/steer…” — pass; Michi node id unchanged

### T-P1-3 Pi event honesty
- `test/piEventMapper.test.ts` — 4/4 pass

### T-P1-4 Frontend queue fork
- `PaneComposerActions.test.tsx` — Steer vs Send next
- `shouldSteerInsteadOfQueue` — Claude false, Codex true

### T-P1-5 Permission source labels
- `PermissionBanner.source.test.tsx` — “Codex approval”

### T-P2-1..4 Pi SDK
- `test/piSdkSession.test.ts` — flag off = agent-core; package missing fallback; no `navigateTree` on Michi branch

### T-P3-1..4 Claude / ACP / Antigravity
- `test/claudeSdkSpike.test.ts` — default off, Teams unavailable
- `test/acpHandshake.test.ts` — Kiro `2025-01-01`, Cursor/Grok `1` locked
- Antigravity descriptor: steer/compact/permissions=`invisible`

### Related existing suites
- `chatHubReplayRing.test.ts`, `claudeSession.test.ts`, `piSession.test.ts` — pass

