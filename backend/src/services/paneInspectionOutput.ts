/**
 * PaneInspectionService's bounded output-reading path — `readOutput` (design §7.3 `read_pane_output`).
 *
 * Reuses P1-6's `resolvePaneTarget` and `authorizeCaller` (backend/src/services/paneInspection.ts)
 * rather than duplicating locator/authorisation logic. Does NOT edit paneInspection.ts (owned by
 * P1-6b in parallel) and does NOT create a routes/tool layer (P1-8/P1-9's job).
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §7.3 (parameters + pagination contract),
 * §6.4 (what output text may/may not contain), §8's cursor-format note (server-side lookup key,
 * not a client-decodable bundle), PANE_INSPECTION_LIMITS, PANE_INSPECTION_ERROR_CODES.
 *
 * Pagination is a CONTENT-SNAPSHOT protocol, not a token-delta stream (§7.3): a page cursor binds
 * the object, outputId, outputRevision and a whole-character boundary. If the underlying content's
 * outputRevision has changed since the cursor was issued, the caller gets OUTPUT_CHANGED and must
 * restart from the newest snapshot — this module never splices a newer turn's text into an older
 * page and never silently skips bytes.
 */

import { randomBytes } from 'node:crypto';
import {
  AgentRunEventType,
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  stripTurnMetadataSentinels,
  type AgentRunEventV1,
  type ExecutionRef,
  type ExecutionSelection,
  type OutputKind,
  type PaneLocator,
} from 'michi-shared';
import { authorizeCaller, resolvePaneTarget, type PaneInspectionCaller } from './paneInspection';
import { chatHub } from '../agents/chatHub';
import { getDb } from './db';
import { listMessages, type MessageRow, type TurnRow } from './dbRepository';
import { AgentRunsRepository } from './agentRunsRepository';
import { compactResultHandoff } from '../agents/runs/resultBundle';

// ---------------------------------------------------------------------------
// Public request/result shapes
// ---------------------------------------------------------------------------

export interface ReadPaneOutputInput {
  locator: PaneLocator;
  selection: ExecutionSelection;
  executionRef?: ExecutionRef;
  outputId?: string;
  pageCursor?: string;
  limitBytes: number;
}

export interface ReadPaneOutputResult {
  outputId: string;
  execution: ExecutionRef | null;
  kind: OutputKind;
  text: string;
  outputRevision: string;
  partial: boolean;
  nextPageCursor: string | null;
}

// ---------------------------------------------------------------------------
// §8 cursor format: server-side lookup key, TTL-bound, never client-decodable.
//
// Mirrors streamTransport.ts's one-use ticket model exactly (randomBytes(32).toString('hex') as
// the map key, an in-memory Map<token, record> with an expiry timestamp) rather than inventing a
// second cursor shape — see the design's §8 cursor note: "此设计与 streamTransport 的一次性 ticket
// 模型一致" (this design is consistent with streamTransport's one-time ticket model).
// ---------------------------------------------------------------------------

const PAGE_CURSOR_TTL_MS = 30_000;

interface PageCursorRecord {
  expires: number;
  /** Scopes this cursor to the caller that issued it — a cursor minted for one caller/workspace
   *  must not be honoured for another, even if the token were somehow guessed (design §8: cursor
   *  "绑定... 调用范围" / binds ... the caller's authorisation scope). */
  scopeKey: string;
  outputId: string;
  outputRevision: string;
  /** Whole-character (code point) offset into the full output text this page left off at. */
  codePointOffset: number;
}

const pageCursors = new Map<string, PageCursorRecord>();

function pruneExpiredCursors(now: number): void {
  for (const [token, record] of pageCursors) {
    if (record.expires <= now) pageCursors.delete(token);
  }
}

function callerScopeKey(caller: PaneInspectionCaller): string {
  // Never an id taken from the request — always the server-derived caller context (brief step 2).
  return `${caller.ownerUserId}:${caller.workspaceId}:${caller.backendConnectionId}`;
}

function mintPageCursor(caller: PaneInspectionCaller, outputId: string, outputRevision: string, codePointOffset: number): string {
  const now = Date.now();
  pruneExpiredCursors(now);
  const token = randomBytes(32).toString('hex');
  pageCursors.set(token, {
    expires: now + PAGE_CURSOR_TTL_MS,
    scopeKey: callerScopeKey(caller),
    outputId,
    outputRevision,
    codePointOffset,
  });
  return token;
}

/**
 * Resolves an incoming pageCursor token to its stored locating info, enforcing caller scope and
 * TTL. Never decodes the token itself — it carries no content, only a lookup key (design §8).
 * Returns null for "expired or unknown" so the caller maps that to OUTPUT_UNAVAILABLE; the
 * cursor is consumed (deleted) on lookup, matching the one-use ticket model this mirrors, since a
 * content-snapshot page cursor's whole purpose (a fixed offset into a fixed revision) is spent
 * once read — a second read of the same page uses the outputId caller-side to re-request page 1
 * cleanly rather than replaying a stale token.
 */
function consumePageCursor(caller: PaneInspectionCaller, token: string): PageCursorRecord | null {
  pruneExpiredCursors(Date.now());
  const record = pageCursors.get(token);
  if (!record) return null;
  if (record.expires <= Date.now()) {
    pageCursors.delete(token);
    return null;
  }
  if (record.scopeKey !== callerScopeKey(caller)) {
    // A cursor issued for a different caller/scope must not be honoured (design §8) — treated
    // identically to "not found" so no information about the other caller's cursor leaks.
    return null;
  }
  pageCursors.delete(token);
  return record;
}

// ---------------------------------------------------------------------------
// UTF-8 / code-point safe pagination helpers
// ---------------------------------------------------------------------------

/**
 * Splits `text` (already the full, unbounded answer text) into the page starting at
 * `startCodePointIndex`, bounded to `maxBytes` of UTF-8, truncated on a whole code-point boundary
 * (never splitting a surrogate pair / multi-byte UTF-8 sequence). Returns the page text, whether
 * more text follows, and the code-point index the NEXT page should start at.
 */
function sliceCodePointPage(
  codePoints: string[],
  startCodePointIndex: number,
  maxBytes: number,
): { pageText: string; nextIndex: number; hasMore: boolean } {
  let byteLen = 0;
  let endIndex = startCodePointIndex;
  for (let i = startCodePointIndex; i < codePoints.length; i += 1) {
    const cpBytes = Buffer.byteLength(codePoints[i], 'utf8');
    if (byteLen + cpBytes > maxBytes) break;
    byteLen += cpBytes;
    endIndex = i + 1;
  }
  // Guarantee forward progress even if a single code point exceeds maxBytes (e.g. limitBytes
  // smaller than one multi-byte character) — emit that one code point alone rather than looping
  // forever or emitting an empty page.
  if (endIndex === startCodePointIndex && startCodePointIndex < codePoints.length) {
    endIndex = startCodePointIndex + 1;
  }
  const pageText = codePoints.slice(startCodePointIndex, endIndex).join('');
  return { pageText, nextIndex: endIndex, hasMore: endIndex < codePoints.length };
}

/** Opaque revision token for a resolved output body — changes whenever the underlying text or its
 *  associated updatedAt changes, distinct from the observation cursor (design §7.3/§8). Mirrors
 *  paneInspectionProjection.chat.ts's own outputRevisionFor so the same content maps to the same
 *  revision whether observed via inspect's preview or readOutput's full body. */
function outputRevisionFor(text: string, updatedAt: number | null): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${updatedAt ?? 'null'}:${text.length}:${(h >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Resolved-content shape — the full (unbounded) text plus its identity, before pagination.
// ---------------------------------------------------------------------------

interface ResolvedOutput {
  outputId: string;
  execution: ExecutionRef | null;
  kind: OutputKind;
  fullText: string;
  outputRevision: string;
  /** True while the underlying execution is still live/streaming — `latest` selection only. */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// §7.3 entry point
// ---------------------------------------------------------------------------

const runsRepository = new AgentRunsRepository();

export function readOutput(caller: PaneInspectionCaller, input: ReadPaneOutputInput): ReadPaneOutputResult {
  const target = resolvePaneTarget(input.locator);
  const authorized = authorizeCaller(caller, target);

  if (input.selection === 'execution' && !input.executionRef) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'is required when selection is "execution"');
  }

  const limitBytes = Math.min(Math.max(1, input.limitBytes), PANE_INSPECTION_LIMITS.readOutputMaxBytes);

  // P1-6b widened authorizeCaller's return union with AuthorizedSurfaceTarget after this module
  // was written. Surface panes (launcher/files/review/file/diff/terminal/browser) have no readable
  // output at all per design §5.1 — every one of those rows is `readOutput: unsupported` — so this
  // is a capability answer, not a fallthrough.
  if (authorized.kind === 'surface') {
    throw new PaneInspectionError(
      'UNSUPPORTED',
      'locator',
      'this pane kind does not expose readable output',
    );
  }

  // Node-backed panes are not all readable either. Design §5.1 gives Digest and Artifact
  // `readOutput: unsupported` — a digest has no assistant answer stream, and artifact/file content
  // stays with the existing file APIs. Without this guard a digest node would be read as if it were
  // a chat and would silently return an empty answer, which §5 forbids: unsupported must not be
  // laundered into an empty success.
  //
  // Match on the two recognised kinds rather than on `!== 'chat'`: P1-6's mapNodeKindToPaneKind
  // deliberately treats every unrecognised/legacy `nodes.kind` value as a chat, so an
  // allow-list here would reject real conversations whose rows predate the current kind values.
  if (authorized.kind === 'node' && (authorized.node.kind === 'digest' || authorized.node.kind === 'artifact')) {
    throw new PaneInspectionError(
      'UNSUPPORTED',
      'locator',
      `pane kind "${authorized.node.kind}" does not expose readable output`,
    );
  }

  const resolved = authorized.kind === 'agent_run'
    ? resolveAgentRunOutput(caller, authorized.run.id, input.selection, input.executionRef)
    : resolveNodeOutput(caller, authorized.node.id, input.selection, input.executionRef);

  // outputId mismatch against a caller-supplied outputId (re-requesting a SPECIFIC prior output
  // identity) means the underlying object no longer resolves to that output at all.
  if (input.outputId && input.outputId !== resolved.outputId) {
    throw new PaneInspectionError('OUTPUT_UNAVAILABLE', 'outputId', 'the requested outputId is no longer available for this target');
  }

  const codePoints = Array.from(resolved.fullText);
  let startIndex = 0;

  if (input.pageCursor) {
    const record = consumePageCursor(caller, input.pageCursor);
    if (!record) {
      throw new PaneInspectionError('OUTPUT_UNAVAILABLE', 'pageCursor', 'the page cursor has expired or is unknown');
    }
    if (record.outputId !== resolved.outputId) {
      // The object no longer maps to the same output identity at all (e.g. a different turn is
      // now "latest") — this is OUTPUT_UNAVAILABLE rather than OUTPUT_CHANGED, since there is no
      // newer snapshot of the SAME output to redirect the caller to.
      throw new PaneInspectionError('OUTPUT_UNAVAILABLE', 'pageCursor', 'the output this cursor was issued for no longer exists');
    }
    if (record.outputRevision !== resolved.outputRevision) {
      // Same output identity, but its content changed since the cursor was minted (a streaming
      // turn advanced, or a new turn superseded it under a stable outputId is not possible here
      // since outputId is turn/attempt-scoped — this branch is the "still the same turn but its
      // text moved on" case). Per §7.3: never silently skip bytes, never splice a newer turn's
      // text into an older page — surface OUTPUT_CHANGED and require a clean re-read.
      throw new PaneInspectionError('OUTPUT_CHANGED', 'pageCursor', 'the output changed between page reads; re-read from the newest snapshot');
    }
    startIndex = record.codePointOffset;
  }

  const { pageText, nextIndex, hasMore } = sliceCodePointPage(codePoints, startIndex, limitBytes);
  const nextPageCursor = hasMore ? mintPageCursor(caller, resolved.outputId, resolved.outputRevision, nextIndex) : null;

  return {
    outputId: resolved.outputId,
    execution: resolved.execution,
    kind: resolved.kind,
    text: pageText,
    outputRevision: resolved.outputRevision,
    partial: resolved.partial,
    nextPageCursor,
  };
}

// ---------------------------------------------------------------------------
// Chat / node-backed resolution
// ---------------------------------------------------------------------------

function resolveNodeOutput(
  caller: PaneInspectionCaller,
  nodeId: string,
  selection: ExecutionSelection,
  executionRef: ExecutionRef | undefined,
): ResolvedOutput {
  if (selection === 'execution') {
    if (!executionRef || executionRef.kind !== 'chat_turn') {
      throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef.kind must be "chat_turn" for a chat target');
    }
    if (executionRef.nodeId !== nodeId) {
      throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef does not belong to the target object');
    }
    const turn = fetchTurnById(executionRef.turnId, caller.ownerUserId);
    if (!turn || turn.node_id !== nodeId) {
      throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef does not identify a known turn on this node');
    }
    // execution mode reaches a failed/cancelled turn's partial output too — read from the live
    // ChatHub observation when this process still has it (covers "failed but never finalized to
    // a persisted message" cases), else fall back to the persisted message body.
    const observation = chatHub.getSnapshot(nodeId);
    if (observation && observation.turnId === turn.turn_id) {
      return resolvedFromObservationAnswer(observation, turn);
    }
    return resolvedFromPersistedTurn(caller, turn);
  }

  const observation = chatHub.getSnapshot(nodeId);

  if (selection === 'latest') {
    if (observation) return resolvedFromObservationAnswer(observation, null);
    const latestTurn = fetchLatestTurnForNode(nodeId, caller.ownerUserId);
    if (!latestTurn) return emptyResolved(null);
    return resolvedFromPersistedTurn(caller, latestTurn);
  }

  // selection === 'last_completed': only a target execution that both COMMITTED and SUCCEEDED.
  // A failed or cancelled execution's partial output is not reachable this way (design §7.3).
  const lastCompleted = fetchLastCompletedTurnForNode(nodeId, caller.ownerUserId);
  if (!lastCompleted) return emptyResolved(null);
  // If ChatHub happens to still hold this exact completed turn in memory, prefer its live answer
  // text (identical content, but avoids a second DB round trip); otherwise read the persisted row.
  if (observation && observation.turnId === lastCompleted.turn_id && observation.durableStatus === 'completed') {
    return resolvedFromObservationAnswer(observation, lastCompleted);
  }
  return resolvedFromPersistedTurn(caller, lastCompleted);
}

function emptyResolved(execution: ExecutionRef | null): ResolvedOutput {
  return { outputId: 'no-execution', execution, kind: 'answer', fullText: '', outputRevision: 'empty:0', partial: false };
}

/** Reads the CURRENT ChatHub in-memory answer text for a turn — this is the same source
 *  paneInspectionProjection.chat.ts's own `answerRawTextFromSnapshot` reads (blocks of kind
 *  'answer', sentinel-stripped), just unbounded rather than preview-truncated. Used for `latest`
 *  (always) and for `execution`/`last_completed` when this process still holds the exact turn in
 *  memory. */
function resolvedFromObservationAnswer(
  observation: import('../agents/chatHub').ChatObservationSnapshot,
  turnRow: TurnRow | null,
): ResolvedOutput {
  const rawAnswer = observation.snapshot.assistantMessage.blocks
    .map((block) => (block.kind === 'answer' ? block.rawText : ''))
    .join('');
  const text = stripTurnMetadataSentinels(rawAnswer);
  const ref: ExecutionRef = { kind: 'chat_turn', nodeId: observation.nodeId, turnId: observation.turnId };
  const updatedAt = observation.completedAt ?? observation.startedAt;
  const partial = observation.durableStatus === 'active';
  return {
    outputId: `chat_turn:${observation.turnId}`,
    execution: ref,
    kind: 'answer',
    fullText: text,
    outputRevision: outputRevisionFor(text, updatedAt),
    partial,
  };
}

/**
 * Reads output text for a turn this process has NO live ChatHub knowledge of, from the persisted
 * `messages` row for that turn's assistant_message_id. `MessageRow.content` is written by
 * `finalizeTurnContent` at commit time (shared/src/turnProjection.ts's `done`/`error` event
 * handling assigns `assistantMessage.content = finalizeTurnContent(rawAnswer)`), i.e. it is
 * ALREADY the sentinel-stripped, title/follow-up-stripped visible answer text — the exact same
 * derivation the chat projection module applies to a live snapshot's blocks, just already
 * computed and stored rather than re-derived from a live block list P1-6b's paneInspection.ts
 * does not fetch. This module fetches the message row itself (see report: no existing
 * dbRepository export returns "one message row by id", only per-node lists) rather than
 * duplicating finalizeTurnContent's parsing logic on raw blocks that no longer exist here.
 */
function resolvedFromPersistedTurn(caller: PaneInspectionCaller, turn: TurnRow): ResolvedOutput {
  const message = fetchMessageById(turn.node_id, turn.assistant_message_id, caller.ownerUserId);
  const ref: ExecutionRef = { kind: 'chat_turn', nodeId: turn.node_id, turnId: turn.turn_id };
  const updatedAt = turn.completed_at ?? turn.checkpoint_at ?? turn.started_at;

  if (turn.status === 'error') {
    // A turn that never committed a persistence-successful output can still have SOME visible
    // text (whatever streamed before the failure) — report it via kind 'answer', but never invent
    // success: this branch is only reachable via `execution` mode's explicit request (§7.3), and
    // `last_completed` already excludes non-completed turns before reaching here.
    const text = message?.content ?? '';
    return {
      outputId: `chat_turn:${turn.turn_id}`,
      execution: ref,
      kind: 'answer',
      fullText: text,
      outputRevision: outputRevisionFor(text, updatedAt),
      partial: false,
    };
  }

  const text = message?.content ?? '';
  return {
    outputId: `chat_turn:${turn.turn_id}`,
    execution: ref,
    kind: 'answer',
    fullText: text,
    outputRevision: outputRevisionFor(text, updatedAt),
    partial: false,
  };
}

// ---------------------------------------------------------------------------
// AgentRun resolution
// ---------------------------------------------------------------------------

function resolveAgentRunOutput(
  caller: PaneInspectionCaller,
  runId: string,
  selection: ExecutionSelection,
  executionRef: ExecutionRef | undefined,
): ResolvedOutput {
  const run = runsRepository.getRun(caller.ownerUserId, runId);
  if (!run) throw new PaneInspectionError('NOT_FOUND', 'runId', 'target not found');

  if (selection === 'execution') {
    if (!executionRef || executionRef.kind !== 'agent_run') {
      throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef.kind must be "agent_run" for an agent-run target');
    }
    if (executionRef.runId !== run.id) {
      throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef does not belong to the target object');
    }
    // §7.3: AgentRun `execution` mode returns the selected attempt's text or the Run handoff —
    // no per-attempt ExecutionRef exists in the shared contract (design §7.2/§7.3 both note this),
    // so "a specific execution" for a Run means the Run's own current/terminal selection, same as
    // `latest` — see the report for why this is a deliberate no-op beyond the validation above.
    return resolveRunLatestOrExecution(caller, run);
  }

  if (selection === 'latest') {
    return resolveRunLatestOrExecution(caller, run);
  }

  // last_completed: only a Run that reached AgentRunStatus.Completed. A Failed/Cancelled run's
  // partial output is reachable only via `execution` (design §7.3) — but since this contract has
  // no per-attempt ExecutionRef, `execution` mode for a Run resolves identically to `latest`
  // (see above); a caller wanting a FAILED run's partial text uses `latest`/`execution` while the
  // Run's own status is still Failed, not `last_completed`.
  if (run.status !== 'completed') return emptyResolved({ kind: 'agent_run', runId: run.id });
  return resolveRunLatestOrExecution(caller, run);
}

function resolveRunLatestOrExecution(
  caller: PaneInspectionCaller,
  run: import('michi-shared').AgentRunDtoV1,
): ResolvedOutput {
  const ref: ExecutionRef = { kind: 'agent_run', runId: run.id };
  const terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';

  if (terminal && run.resultBundle) {
    const text = compactResultHandoff(run.resultBundle);
    return {
      outputId: `run-handoff:${run.id}`,
      execution: ref,
      kind: 'handoff',
      fullText: text,
      outputRevision: `${run.id}:${run.completedAt ?? run.latestEventSeq}`,
      partial: false,
    };
  }

  const attempts = runsRepository.listAttempts(caller.ownerUserId, run.id);
  const attempt = run.activeAttemptId
    ? attempts.find((a) => a.id === run.activeAttemptId) ?? null
    : (attempts.length > 0 ? attempts.reduce((latest, a) => (a.attemptIndex > latest.attemptIndex ? a : latest)) : null);

  if (!attempt) return emptyResolved(ref);

  // §6.4/§10: aggregate assistant text WITHIN ONE ATTEMPT ONLY, filtered by attemptId and
  // concatenated in seq order — Assistant event payloads are `{ version: 1, text: string }`
  // DELTAS stamped with attemptId by the coordinator (runtimeRunExecutor.ts:150), per P1-3.
  // listEvents already returns rows ordered by seq (agent_run_events PK is (run_id, seq) and the
  // repository selects in that order) — re-sorting defensively rather than trusting call order.
  const allEvents = runsRepository.listEvents(caller.ownerUserId, run.id, -1, Math.max(1, run.latestEventSeq + 1));
  const text = assistantTextForAttempt(allEvents, attempt.id);

  return {
    outputId: `run-attempt:${attempt.id}`,
    execution: ref,
    kind: 'answer',
    fullText: text,
    outputRevision: `${attempt.id}:${run.latestEventSeq}`,
    partial: !terminal,
  };
}

/** Filters to ONE attemptId and concatenates deltas in seq order — never a cross-attempt merged
 *  transcript (P1-3 / COMMON.md). Mirrors paneInspectionProjection.run.ts's own
 *  `assistantTextForAttempt`, kept duplicated here rather than imported: that module is a PURE
 *  projection with no repository access and this module needs the unbounded (non-preview-capped)
 *  text, so importing it would not save the filter/concat logic itself — see the report for the
 *  extraction recommendation. */
function assistantTextForAttempt(events: readonly AgentRunEventV1[], attemptId: string): string {
  return events
    .filter((event) => event.type === AgentRunEventType.Assistant && event.attemptId === attemptId)
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((event) => {
      const payload = event.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { text?: unknown }).text === 'string') {
        return (payload as { text: string }).text;
      }
      return '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// DB fetch helpers — mirrors paneInspection.ts's own owner-scoping convention exactly
// (dbRepository.getMessageCount's `process.env.MICHI_CLOUD === '1' && userId` branch), rather
// than inventing a new one (COMMON.md decision 5). No existing dbRepository export returns "the
// latest turn for a node", "the last completed turn for a node", "a turn by id", or "a single
// message row by id with owner scoping" — this module owns those, same division of labour as
// paneInspection.ts's own turn-fetch helpers.
// ---------------------------------------------------------------------------

function fetchLatestTurnForNode(nodeId: string, userId?: string): TurnRow | null {
  const cloudScoped = process.env.MICHI_CLOUD === '1' && userId;
  const row = cloudScoped
    ? getDb().prepare(
        `SELECT t.* FROM turns t
         JOIN nodes n ON t.node_id = n.id
         JOIN workspaces w ON n.workspace_id = w.id
         WHERE t.node_id = ? AND w.owner_user_id = ?
         ORDER BY t.started_at DESC LIMIT 1`,
      ).get(nodeId, userId)
    : getDb().prepare('SELECT * FROM turns WHERE node_id = ? ORDER BY started_at DESC LIMIT 1').get(nodeId);
  return (row as TurnRow | undefined) ?? null;
}

function fetchLastCompletedTurnForNode(nodeId: string, userId?: string): TurnRow | null {
  const cloudScoped = process.env.MICHI_CLOUD === '1' && userId;
  const row = cloudScoped
    ? getDb().prepare(
        `SELECT t.* FROM turns t
         JOIN nodes n ON t.node_id = n.id
         JOIN workspaces w ON n.workspace_id = w.id
         WHERE t.node_id = ? AND w.owner_user_id = ? AND t.status = 'completed'
         ORDER BY t.started_at DESC LIMIT 1`,
      ).get(nodeId, userId)
    : getDb().prepare(
        `SELECT * FROM turns WHERE node_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`,
      ).get(nodeId);
  return (row as TurnRow | undefined) ?? null;
}

function fetchTurnById(turnId: string, userId?: string): TurnRow | null {
  const cloudScoped = process.env.MICHI_CLOUD === '1' && userId;
  const row = cloudScoped
    ? getDb().prepare(
        `SELECT t.* FROM turns t
         JOIN nodes n ON t.node_id = n.id
         JOIN workspaces w ON n.workspace_id = w.id
         WHERE t.turn_id = ? AND w.owner_user_id = ?`,
      ).get(turnId, userId)
    : getDb().prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId);
  return (row as TurnRow | undefined) ?? null;
}

/** Single message-row-by-id fetch, owner-scoped like every other read in this module. Falls back
 *  to a plain per-node scan via the existing `listMessages` export rather than adding a second
 *  raw-SQL owner-scoping branch for a one-row lookup — turns have at most a few dozen messages on
 *  a node in practice, and this keeps the owner-scoping logic in exactly one place
 *  (dbRepository.listMessages) rather than three. */
function fetchMessageById(nodeId: string, messageId: string, userId?: string): MessageRow | null {
  const rows = listMessages(nodeId, userId);
  return rows.find((row) => row.id === messageId) ?? null;
}
