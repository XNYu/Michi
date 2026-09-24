# Kiro ACP Implementation And Validation

Validated on September 23, 2026 (America/Los_Angeles; the final logs use
September 24 UTC), with the installed `kiro-cli 2.24.0`, v3 KAS `0.66.8`,
Node `24.19.0`, and Chromium. Real model tests used `claude-opus-4.7` with
`low` reasoning. These are tested versions, not a claim about the latest release.

## Activation

The default remains **v2**. Michi explicitly passes `--agent-engine v2` and
does not inherit changes to the CLI's default. v3 is available only when the
backend is explicitly launched with `MICHI_KIRO_ENGINE=v3`. No engine-switch
UI, global preference change, installed-app replacement, or session migration
was performed.

## Runtime Contract

| Capability | v2 | v3 |
| --- | --- | --- |
| ACP handshake | Numeric protocol version 1 | Numeric protocol version 1 |
| Launch/auth | v2 flags, including session model setup | v3 flags and CLI-mediated authentication |
| Model/effort | `session/set_model` and `effort` command | Native dynamic `configOptions` |
| Active-turn steering | `_session/steer` and queue clear | Same extension, retaining native message IDs |
| Native fork | `rewind` command creates an independent native session | `session/fork` creates an independent native session |
| Historical fork | Server-recorded native `logIndex` | Server-recorded native message ID |
| Resume | Engine-scoped native binding | Engine-scoped native binding and replay suppression |
| Michi MCP routing | Child-specific slot | Child-specific slot and isolated process per chat/Run |
| Permissions | Native permission options | Native option IDs/kinds and scoped consent metadata |
| Usage | Existing native metadata | Normalized context/credits; missing metrics stay unknown |
| Compaction | Wait for the native completed notification | Wait for the dedicated compact RPC |

Native steering does not cancel/restart the turn or create a second durable
turn. Rejected input remains queued in the UI. Cancellation waits for outstanding
steer requests, clears native pending steering, and quarantines an uncertain
session instead of leaking stale input into the next turn.

Fork selection uses persisted ownership, workspace/tree identity, runtime engine,
and native anchors. Runtime IDs are not accepted from client message metadata.
The child has a distinct native session and MCP destination; the parent is not
rewound in place. Agent Run recovery tokens also record the engine.

Compaction carries the pane owner token. HTTP 403 and busy-session refusals do
not fall through into another command or a model prompt. Compaction reserves
the native session while running and waits for preceding steering cleanup even
when the UI has already received the prior turn's completion.

## Automated Verification

| Check | Result |
| --- | --- |
| Production frontend/backend build | Passed |
| Frontend TypeScript, including tests | Passed |
| Full frontend unit/component suite | 264 files; 2476 passed, 1 skipped |
| Full backend suite | 1931 tests; 1923 passed, 8 opt-in/platform skips, 0 failures |
| Focused Kiro/recovery browser E2E | 11 cases repeated three times; all 33 passed |
| Dual-engine protocol regression tests | 25 passed, also included in the full backend suite |
| Browser stream-transport stress test | Passed: 30 streams on one WebSocket; control requests remain responsive |
| Full browser E2E run | 97 passed, 20 failed, 4 skipped; not a green repository-wide gate |
| Whitespace/error check (`git diff --check`) | Passed |

Protocol regressions cover numeric handshake, per-engine model configuration,
native fork anchors, active-turn exclusion, replay suppression, permission
validation, usage normalization, prompt completion ordering, steering/cancellation
races, compaction notification ordering, timeouts, process/session teardown,
and immediate compact after native steering cleanup.

The full frontend lint command was also run. It is **not green**: three errors
already present in HEAD remain in `AttachmentPills.tsx:43`,
`PaneMessageList.tsx:24`, and `usePanePresenceIntegration.test.ts:410`, plus
existing warnings. They were not hidden or changed as part of the Kiro work.
An earlier full backend run encountered a macOS file-watch timing failure;
the focused seven-test watcher suite and the final full backend run passed
without changing the watcher implementation or its tests. The stream-capacity
test still holds 256 simultaneous streams, but opens sockets in batches to
avoid testing the OS loopback accept backlog instead of the stream limit.

The full browser suite exposed 20 failures: two composer transition-duration
expectations, obsolete/missing navigation or agent-menu selectors, three pane
animation expectations, ten pane-width/motion cases, two scroll-anchor cases,
and one recovery test measuring the desktop layout before the resize settled.
The recovery test now polls the actual responsive bounds instead of reading a
single stale frame; all 33 scoped repetitions then passed. The other full-suite
failures were not hidden by changing product behavior or weakening their
assertions. The separately rerun Kiro/recovery suite is the scoped gate.

## Real CLI And UI Verification

`backend/test/kiroDualEngineSmoke.test.ts` passed eight real turns per engine:

1. Record a fictional project name through the real Michi MCP tool.
2. Rename it in a later parent turn.
3. Fork at the earlier stored native anchor; the child recalls only the old name.
4. Verify the parent still recalls the later name and keeps its original ID.
5. Release/load the child and verify native history and engine identity.
6. Steer a running response to choose a different color.
7. Cancel a turn with steering pending.
8. Continue successfully without the cancelled steering leaking into the answer.

Both final runtime records contain two independent native sessions, eight
branch-overview deliveries, and no runtime-error events. v3 exercised actual
permission requests as well. Compaction was also invoked through the runtime.

`backend/scripts/kiro-ui-smoke.mjs` passed four real turns per engine through
the built production UI, a real backend, SQLite, real MCP, and the installed CLI:

1. Create a workspace and complete the parent turn.
2. Branch through the composer and assert `resumeReason: native_fork`, distinct
   native IDs, matching engine, and native history recall.
3. Queue and click **Steer now**; verify native acceptance, the changed answer,
   and exactly three total durable turns (no extra steering turn).
4. Complete `/compact`, refresh, reopen the existing branch, and ask again.
   Verify both the original project name and the steered color survive.

Both UI runs reported zero browser page errors and captured desktop/mobile
branch views, steering controls, and the restored conversation. These are
behavior assertions on model output and persisted state, not just successful
HTTP status checks.

## Steering Report Follow-up (September 24, 2026)

Kiro's inline `[STEERING steer-...: explanation]` output is now parsed once,
incrementally, in the Kiro adapter. Both v2 and v3 native ID formats become
`steering_report` events with `source: model` and `confidence: unverified`.
They are model-authored explanations, not proof that the requested action ran.
The frontend shows them in a collapsed **Steering notes** disclosure marked
**Model-reported**, without displaying native IDs in the answer.

Reports survive durable checkpoints, replay, cancellation, database reopen,
frontend hydration, and workspace export. Legacy inline reports are extracted
on load; code examples and user messages are retained. Unterminated reports
are marked incomplete, and report buffering is capped at 8192 characters.
The incremental scanner is O(N) in received text and makes no model or network
calls. This is not a complexity claim about the entire rendering pipeline.

Follow-up validation:

- Production build and frontend TypeScript passed.
- Full frontend suite: 266 files, 2486 passed, 1 skipped.
- Full backend suite: 1942 tests, 1934 passed, 8 skipped, 0 failures.
- Steering controls and report browser specs: 8 cases repeated three times,
  all 24 passed, including desktop/mobile, keyboard interaction, and reload.
- Replayed saved real v2/v3 runtime outputs through the parser without new
  inference. The v3 record contained a native steering report that was extracted.
- Verified the existing `123` / `456` conversation against the real isolated
  backend and production frontend: collapsed by default, readable on expansion,
  no raw marker or native ID, no mobile overflow, successful reload, and zero
  browser page errors. No new model requests were sent.

The isolated v2 preview was refreshed; the installed Electron app was not
replaced. The earlier full-browser and lint limitations above remain; those
repository-wide gates were not rerun here.

## Isolated Commit Verification (September 24, 2026)

Before committing, the complete Kiro change was reconstructed on top of
`c39c21112c29d01b4dc2f1b205a16d585b39ddd1` in a separate worktree. Unrelated
concurrent runtime, settings, attachment, and navigation changes were excluded.
The minimal shared native-fork and idle-compaction wiring required by Kiro
remains part of this change.

- Production frontend/backend build and frontend TypeScript passed.
- Full frontend suite: 263 files, 2428 passed, 1 skipped, 0 failures.
- Full backend suite: 1897 tests, 1891 passed, 6 skipped, 0 failures.
- The three Kiro steering/report/recovery browser specs passed all 14 cases
  against both the development server and the production build.
- The production run avoided the linked-dependency font-path restriction seen
  in the isolated development server. Desktop/mobile screenshots were inspected.
- No real-model requests were repeated during commit isolation. The live CLI
  and UI evidence above is from the earlier complete runtime verification.

These counts differ from the earlier mixed-workspace runs because unrelated
concurrent tests are not part of this commit. The previously documented full
browser-suite and lint limitations remain; those gates were not rerun here.

## Reproduction

Use Node 22+ for SQLite. Ordinary tests require no live CLI or credentials:

```bash
npm run build
npm run typecheck -w frontend
npm test -w frontend
npm test -w backend
E2E_PORT=4329 npm run test:e2e -- e2e/specs/kiro-steer.spec.ts e2e/specs/kiro-recovery-status.spec.ts --workers=2 --repeat-each=3
E2E_PORT=4336 npm run test:e2e -- e2e/specs/kiro-steering-reports.spec.ts e2e/specs/kiro-steer.spec.ts --workers=2 --repeat-each=3
npm run test:stream-transport
```

The following opt-in tests use the installed Kiro account and consume model
quota. Run real engines sequentially to avoid unnecessary startup contention.

```bash
cd backend
MICHI_KIRO_SMOKE=v2,v3 node --require ts-node/register --test --test-timeout=420000 test/kiroDualEngineSmoke.test.ts
```

From the repository root, after building:

```bash
MICHI_KIRO_UI_SMOKE=v2 node backend/scripts/kiro-ui-smoke.mjs
MICHI_KIRO_UI_SMOKE=v3 node backend/scripts/kiro-ui-smoke.mjs
```

Set `MICHI_KIRO_SMOKE_OUTPUT` to an existing evidence directory to retain JSON,
server logs, and screenshots. UI smoke data/config/workspace directories are
temporary and printed in the result; the script stops its backend afterward.
The CLI uses its normal authentication/configuration and writes its own native
test sessions. The user's Michi database and installed Electron application are
not used or replaced.

## Boundaries

- Conversation rewind does **not** restore workspace files.
- Active/incompatible parents, custom-agent branches, and historical messages
  without stored native anchors use the existing textual-context fallback.
- v2 and v3 native session formats are not interchangeable. Legacy bindings
  count as v2; cross-engine reconstruction is never reported as native resume.
- Verification covers Michi's runtime integration, not a new UI for every Kiro
  workflow/cloud/checkpoint-management extension. Experimental subagent roster
  coverage is not promoted to guaranteed native support.
- Real execution still depends on the account, model service, and configured
  third-party MCP servers. An earlier v3 startup hit an upstream model-directory
  timeout; Michi did not silently choose a different model. Subsequent complete
  live runs passed. No claim is made that all future CLI builds or environments
  are guaranteed to behave identically.
