# Performance Audit — Safe Implementation Plan

> Worktree: `/private/tmp/rabbitholes-performance-audit`
> Branch: `codex/performance-audit-20260718`
> Mode: bug fix / behavior-preserving performance refactor
> Method: SPEC → RED → GREEN → REFACTOR → VERIFY → EVIDENCE
> Visual evidence: `docs/superpowers/reports/performance-audit-2026-07-18.html`

## Success criteria

### Functional

- [x] Desktop composer submits the latest text, mentions and quote even when Enter follows an edit before the next animation frame.
- [x] Draft clearing cannot be undone by a pending RAF/debounce; mobile semantics remain local-state based and unchanged.
- [x] The desktop primary action flips synchronously on empty↔non-empty transitions, so a pre-RAF click cannot stay disabled or cancel a live turn instead of queueing.
- [x] Frontend and backend transcript fingerprints remain byte-for-byte compatible with existing persisted values.
- [x] Streaming snapshots avoid per-chunk full-content derivation while checkpoints and terminal events persist identical visible content.
- [x] In-progress tool output is throttled; terminal tool state and turn finalization remain durable.
- [x] Inactive history stubs use a 30-minute TTL + 256-entry LRU without evicting live runtime sessions; an active deep chain is protected only until copied to the caller, then the resident cap is restored.
- [x] Markdown, raw HTML sanitization, math rendering, unread/counts and Map topology remain visually and semantically unchanged.

### Observable

- [x] `set-composer-draft` does not advance the structural version.
- [x] Same-tick editor/toolbar regressions send the final text, mentions and quote; streaming toolbar action queues instead of stopping.
- [x] Golden fingerprint vectors pass in shared/frontend/backend.
- [x] Chunk snapshots keep active `content` deferred; checkpoint DB rows contain the partial answer; done/error contain finalized content.
- [x] Production `index.html` has no math modulepreload or math stylesheet link until math is requested.
- [x] Map visibility output is unchanged and topology-only changes invalidate layout.
- [x] `audit.db` remains `synchronous=FULL`; untouched auth SQLite keeps its default FULL durability; `data.db` is `NORMAL`.

### Pass/fail gates

- [x] Targeted tests demonstrate RED before implementation and GREEN after implementation.
- [x] Frontend Vitest passes: 462 suites / 1272 tests.
- [x] Backend typecheck and critical replay/context/outbox tests pass; 74 independently executed test files exit 0. The remaining `claudeSession.test.ts` runner does not auto-exit after partial completion and is recorded as verification debt instead of blocking delivery with repeated reruns.
- [x] Frontend/backend typecheck and the root production build pass.
- [x] Playwright E2E passes: 10 passed / 4 intentional skips, including stream/branch/cancel/scroll behavior.
- [x] Before/after bundle sizes and verification commands are captured for the HTML report.

## Implementation-ready batches

### Batch A — input, persistence and fingerprint

- [x] Safe composer RAF batching with synchronous submit source and synchronous action-mode boolean.
- [x] Start the advisory capability probe without awaiting it; meta remains the only readiness/retry gate.
- [x] Remove `WorkspaceDirtyDelta.messageNodeIds`.
- [x] Index bulk edge/context lookups only when needed.
- [x] Shared streaming FNV implementation and finalized-content cache.

### Batch B — streaming and backend durability

- [x] Defer active chunk content and materialize it only at checkpoint.
- [x] Throttle active `tool_call_update`; checkpoint terminal states immediately.
- [x] Cache static hot-path statements; clear cache with DB close.
- [x] Apply `synchronous=NORMAL` to `data.db` only.
- [x] Add stub-only TTL/LRU eviction with a tested deep-chain allowance/trim boundary.

### Batch C — render, chrome and bundle

- [x] Restore lazy KaTeX chunk boundary by removing the broad unified/rehype manual grouping and verifying built artifacts.
- [x] Skip raw/sanitize plugins when input cannot contain HTML.
- [x] Skip grapheme segmentation for already-complete messages.
- [x] Stabilize ThreadRow/WorkspaceRow/Topbar selectors and project-scope status reads.
- [x] Make Map visibility O(N+E) and stabilize topology dependencies.

### Batch D — foreground/background transport split

- [x] Reproduce the HTTP/1.1 six-connection starvation in real Chromium.
- [x] Replace one permanent `/subscribe` connection per pane with one ChatProvider-lifetime background connection.
- [x] Keep user turns on temporary direct SSE and recover a hydrated foreground turn through turn-scoped `/stream` replay.
- [x] Split foreground replay cursors from background delivery watermarks so a later foreground turn cannot skip a missed self-turn.
- [x] Make durable gaps ordering barriers, emit all cross-chat gap controls before replay frames, and abort/refetch snapshots across local edits.
- [x] Bind Stop/cancel to turnId; atomically consume durable spawn outbox entries at `beginTurn`; preserve pane focus during background spawn.
- [x] Add a 20-binding single-fetch contract test plus real-Chromium HTTP/1.1 before/after connection probes.

Residual limit: simultaneously active user `/message` turns still consume one HTTP request each. This batch removes idle observer starvation without forcing all output through one multiplexed channel; HTTP/2 or a unified event bus remains optional future work, not a prerequisite for the current pane experience.

## Design and measurement gates

- [ ] Benchmark and property-test incremental Markdown lexing before M1.
- [ ] Design a trailing reveal-animation window before M2.
- [ ] Add first-paint/focus/IME tests before Markdown or TipTap lazy loading.
- [ ] Design virtualization together with scroll restore, follow-pin and PaneFind.
- [ ] Design eviction together with Global Search coverage.
- [ ] Add cancel-and-wait-terminal before live-session cleanup on destructive routes.

## Verification evidence to collect

- Baseline and final build output: captured; root `npm run build` exits 0.
- RED and GREEN output: captured for composer payload/action mode, persistence/fingerprint, render/bundle, backend checkpointing/cache/stub eviction, and SSE replay/reconnect.
- Full frontend: 462 suites / 1272 tests; typecheck passes.
- Backend: typecheck passes; critical replay/context/outbox tests pass; 74 independently executed test files exit 0. `claudeSession.test.ts` has a non-exiting runner that remains explicit verification debt.
- E2E: 10 passed / 4 intentional skips.
- Real Chromium HTTP/1.1 probe: before, six permanent streams leave `/ping` pending; after, 20 logical subscriptions use one observer connection and `/ping` returns `pong`.
- Boot JS graph: 1,711,974 B raw / 523,055 B gzip → 1,386,673 B raw / 425,432 B gzip (about 19% smaller). Dynamic math assets: JS 267,188 / 79,648; CSS 28,933 / 8,076; neither is linked/preloaded at boot.
- `npm run frontend:verify-bundle`: passes; checks HTML, boot static imports and KaTeX engine signature.
- `git diff --check`: passes.
- Baseline debt, not changed here: `npm run lint` still reports 10 hook-order errors in `ToolCallGroup.tsx` and `UserInputBanner.tsx`; both files are byte-identical to HEAD.
