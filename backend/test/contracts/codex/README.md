# Codex App-Server Contracts

This is a consumer-contract suite, not a complete Codex feature implementation.
Normal PR tests are offline and do not spawn Codex, call a model, read user
credentials, or touch the user's data/log directories. Node.js 22+ is required.

## Baseline

`baseline/manifest.json` pins Codex CLI **0.156.1**, `--experimental`, the
initialize capabilities and SHA-256 hashes. The generated JSON bundle and three
TypeScript union snapshots retain the official generator's bytes. The `.ts.txt`
files are reference snapshots, not runtime imports or a complete TS SDK. Tests
extract their discriminants with the TypeScript AST and validate actual JSON
payloads with Ajv, not a handwritten schema.

The same binary produces **84 TS notifications but 82 JSON notifications**:
`rawResponse/completed` and `rawResponseItem/completed` are absent from the JSON
union. `dispositions.ts` records this exact version-scoped exception; neither
artifact is patched. Both raw notifications are explicitly ignored by Michi.
There are also **11 server requests and 19 ThreadItem variants**.

The source is the official app-server documentation at
<https://learn.chatgpt.com/docs/app-server>. A generator reflects its binary's
version, not a claim that the installed binary is the newest available release.

## Checks

- Every official notification, server request, item and selected consumed status
  enum must have an explicit disposition. Additions, removals, duplicate entries
  and misspellings fail the inventory check. `partial` and `deferred` are visible
  debt, not passing claims of full support. Tested entries reference registered
  contract cases; this does not prove every field of a partial entry is covered.
- Requests and notifications are validated before entering fake child stdout.
  Tests use the real JSONL reader, Runtime and Session and inspect serialized
  stdin replies. Response envelope, method-specific result schema and native ID
  are checked separately. Client-side setup responses are lightweight transport
  stubs, not assertions that every client RPC response is covered.
- Semantic assertions cover question-ID correspondence with duplicate wording,
  empty grants, declined elicitation, stale turns, resolved-request races, scope
  isolation, one reply per callback, compaction and durable terminal projection.
- Mutations change runtime ASTs only inside child test processes: compact
  spelling, declined-as-completed and question-label-as-ID. Each must fail its
  intended test, after the unmodified suite passes. No workspace files are edited.

```bash
# Included automatically by the existing backend/test/*.test.ts suite.
npm run test:codex-contract -w backend
npm run test:codex-contract:mutations -w backend

# Optional maintainer check; requires the pinned CLI, but no model invocation.
npm run codex:contract:check -w backend -- --codex /path/to/codex

# Review another version without overwriting the accepted baseline.
npm run codex:contract:generate -w backend -- \
  --version VERSION --codex /path/to/candidate-codex --out /tmp/codex-candidate
MICHI_CODEX_CONTRACT_BASELINE=/tmp/codex-candidate npm run test:codex-contract -w backend

# Only after reviewing differences and updating dispositions/tests:
npm run codex:contract:generate -w backend -- --version VERSION --codex /path/to/codex
```

Keep candidate checks separate from offline PR checks. An unchanged old baseline
cannot discover future upstream changes by itself. The repository has no CI
workflow here; the commands above are integration points, not a scheduled job.

## Product Boundaries

- Native permission profiles return `{ permissions: {}, scope: 'turn' }`. They
  must not be passed through a generic command-approval decision or persisted as
  an always-allow tool grant. Scoped approval UI and positive subset tests are
  deferred; this suite currently promises only the empty subset.
- MCP form/URL elicitation is declined until a real form/verification flow exists.
  Future positive tests must validate content against that request's
  `requestedSchema`, not just the nullable response envelope.
- Native user-input answers carry question IDs through shared parsing and UI.
  Old clients may use an unambiguous label; ambiguous labels are never guessed.
  Secret prompts return an empty answer map without entering ordinary UI/history.
  Secret input, `isOther`, nonblocking and auto-resolution UI semantics are deferred.
- `serverRequest/resolved` aborts local waiters and prevents late replies/grants;
  user-input resolution is emitted. A dedicated permission-banner resolution
  event is still needed; a stale banner cannot grant or reply to the cleared request.
- Declined tool status is preserved into durable projection. Dedicated declined
  styling is not included. Native interruption normalizes to `cancelled`.
- Independent idle compaction, global/idle MCP startup, plan/diff/authoritative
  text reconciliation, new item rendering, all client APIs, reconnect/replay
  traces and live-daemon compatibility are not certified by this first batch.
- Unknown requests return JSON-RPC errors. Unknown notifications remain tolerated;
  bounded protocol-drift telemetry is still deferred.
