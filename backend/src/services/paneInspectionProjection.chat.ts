/**
 * Chat adapter: projects already-fetched chat-node inputs into a PaneDescriptorV1.
 *
 * PURE MODULE — no database access, no ChatHub calls, no `chatHub` singleton import, no
 * `Date.now()`. Every clock read the caller may need (currently just `observedAt`) is injected.
 * This purity is what lets every row of the design doc's §6.1 state table be unit-tested with
 * plain object fixtures instead of a live runtime.
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §6.1 (state table), §6.2 (times), §6.3
 * (statistics/lineage), §6.4 (latest output), §5 (Section<T> rules).
 */

import {
  stripTurnMetadataSentinels,
  encodePaneId,
  PANE_INSPECTION_LIMITS,
  type PaneDescriptorV1,
  type Section,
  type ExecutionSnapshot,
  type ExecutionRef,
  type OutputPreview,
  type PaneActivity,
  type ExecutionStatus,
  type CommitState,
  type DurableTurnSnapshot,
} from 'michi-shared';
import type { ChatObservationSnapshot } from '../agents/chatHub';
import type { NodeRow, TurnRow } from './dbRepository';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface ChatNodeToDescriptorInput {
  /** Already-fetched node row (P1-6's job to fetch). */
  node: NodeRow;
  /** ChatHub.getSnapshot(nodeId) result — null means this process has no in-memory
   *  knowledge of the node, NOT that no turn ever existed. */
  observation: ChatObservationSnapshot | null;
  /** Latest persisted turn row for this node, or null if none exists in SQLite. */
  durableTurn: TurnRow | null;
  /** Persisted message counts (dbRepository.getMessageCountsByNode). */
  counts: { total: number; user: number; assistant: number };
  /** Persisted completed-turn statistics (dbRepository.getCompletedTurnCount). */
  turns: { count: number | null; coverage: 'complete' | 'partial' };
  lineage: {
    parentNodeId: string | null;
    treeRootNodeId: string | null;
    childNodeIds: string[];
    childrenTruncated: boolean;
    originMessageId: string | null;
  };
  runtime: {
    runtimeId: string | null;
    modelId: string | null;
    providerId: string | null;
    contextUsagePercentage: number | null;
  };
  /** P2-1 supplies this; accepted as given, never computed here. */
  presence: PaneDescriptorV1['presence'];
  backendConnectionId: string;
  /** Injected clock reading. Never read Date.now() inside this module. */
  observedAt: number;
  /** Previous turn's output preview, carried forward when the CURRENT turn (durableTurn /
   *  observation) has produced no visible answer text yet. Optional: P1-6 supplies it only
   *  when it has one available (e.g. from its own prior read or a cache); omitted or null both
   *  mean "no earlier preview known", not an error. */
  previousOutput?: OutputPreview | null;
  firstExecutionStartedAt?: number | null;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

export function chatNodeToDescriptor(input: ChatNodeToDescriptorInput): PaneDescriptorV1 {
  const { node, observation, durableTurn, counts, turns, lineage, runtime, presence, backendConnectionId, observedAt } = input;

  const { activity, execution, commitState: _commitState } = deriveActivityAndExecution(input);

  return {
    version: 1,
    ref: { backendConnectionId, paneId: encodePaneId({ kind: 'node', nodeId: node.id }) },
    target: { kind: 'node', nodeId: node.id },
    kind: 'chat',
    title: node.title ?? '',
    workspaceId: node.workspace_id,
    treeId: node.tree_id ?? null,
    archived: isArchivedPaneNode(node),
    truncatedFields: [],
    observation: {
      observedAt,
      freshness: observation ? 'live' : 'persisted',
      cursor: observationCursor(observation, durableTurn),
    },
    capabilities: { readOutput: true, subscribe: true, waitForTerminal: true },
    activity,
    execution,
    timeline: {
      resourceCreatedAt: node.created_at,
      firstExecutionStartedAt: input.firstExecutionStartedAt ?? null,
    },
    presence,
    conversation: {
      status: 'ready',
      value: {
        messageCount: counts.total,
        userMessageCount: counts.user,
        assistantMessageCount: counts.assistant,
        completedTurnCount: turns.count,
        turnHistoryCoverage: turns.coverage,
      },
    },
    lineage: {
      status: 'ready',
      value: {
        parentNodeId: lineage.parentNodeId,
        parentRunId: null,
        originMessageId: lineage.originMessageId,
        treeRootNodeId: lineage.treeRootNodeId,
        childNodeIds: lineage.childNodeIds,
        childrenTruncated: lineage.childrenTruncated,
      },
    },
    runtime: {
      status: 'ready',
      value: {
        runtimeId: runtime.runtimeId,
        modelId: runtime.modelId,
        providerId: runtime.providerId,
        contextUsagePercentage: runtime.contextUsagePercentage,
      },
    },
    latestOutput: deriveLatestOutput(input),
  };
}

// ---------------------------------------------------------------------------
// §6.1 state table — activity / execution / commitState
// ---------------------------------------------------------------------------

interface ActivityAndExecution {
  activity: PaneActivity;
  execution: Section<ExecutionSnapshot | null>;
  /** Exposed for tests / callers that want the raw commitState without unwrapping execution. */
  commitState: CommitState | null;
}

function deriveActivityAndExecution(input: ChatNodeToDescriptorInput): ActivityAndExecution {
  const { node, observation, durableTurn, counts, observedAt } = input;

  // Row: "有 pending spawn prompt，但 turn 尚未开始" — a spawn prompt is queued for this node
  // but ChatHub has not started a turn and SQLite has no turn row either. Detected by the
  // durable node-level draft/spawn marker rather than inventing a turnId.
  const hasPendingSpawn = node.spawned_by_agent === 1 && !observation && !durableTurn;

  // Row: "新 chat，数据库确认无 turn/消息" — brand-new chat, DB confirms no turn and no messages.
  if (!observation && !durableTurn && counts.total === 0) {
    if (hasPendingSpawn) {
      return { activity: 'queued', execution: { status: 'ready', value: null }, commitState: null };
    }
    return { activity: 'unstarted', execution: { status: 'ready', value: null }, commitState: null };
  }

  // Row: "老数据仅有消息而无 turn 记录" — old data with messages but no turn record anywhere.
  // Never infer a successful outcome from the last assistant message.
  if (!observation && !durableTurn && counts.total > 0) {
    return {
      activity: 'unknown',
      execution: { status: 'unknown', reason: 'no turn record exists for this node; message history predates turn persistence' },
      commitState: 'unknown',
    };
  }

  // From here at least one of {observation, durableTurn} is present.
  const cancelling = deriveCancelling(observation, observedAt);
  if (cancelling) return cancelling;

  // ChatHub has a live in-memory view — it is authoritative over a possibly-stale durable row
  // for the SAME turn, and is the only source for "running"/"waiting" activity.
  if (observation) {
    return deriveFromObservation(observation, durableTurn);
  }

  // observation === null but a durable turn row exists: this process has no in-memory knowledge
  // (never saw it, or saw it before a restart) but SQLite has an authoritative outcome. Report
  // that outcome directly — do not read the absence of an in-memory record as failure.
  return deriveFromDurableTurnOnly(durableTurn as TurnRow);
}

/** Row: "已请求取消但未确认终止" — cancelling is derived here, never by ChatHub/AgentRun. */
function deriveCancelling(
  observation: ChatObservationSnapshot | null,
  observedAt: number,
): ActivityAndExecution | null {
  if (!observation || observation.cancelRequestedAt === null) return null;
  // Once ChatHub's own view reports a terminal durableStatus, the authoritative terminal state
  // has arrived — this is no longer "cancelling" from this projection's perspective; the caller
  // falls through to deriveFromObservation, which reports the real terminal outcome.
  if (observation.durableStatus !== 'active') return null;

  const elapsed = observedAt - observation.cancelRequestedAt;
  const timedOut = elapsed > PANE_INSPECTION_LIMITS.cancelTimeoutMs;

  const ref: ExecutionRef = { kind: 'chat_turn', nodeId: observation.nodeId, turnId: observation.turnId };
  const value: ExecutionSnapshot = {
    ref,
    assistantId: observation.assistantId,
    attemptId: null,
    attemptIndex: null,
    status: 'cancelling',
    startedAt: observation.startedAt,
    endedAt: null,
    commitState: 'pending',
    waitingReason: null,
    error: timedOut
      ? { code: 'CANCEL_TIMEOUT', message: 'Cancel was requested more than 15s ago and no authoritative terminal status has arrived yet.' }
      : null,
  };
  // activity stays 'cancelling' regardless of the timeout — only the authoritative source may
  // conclude 'cancelled'.
  return { activity: 'cancelling', execution: { status: 'ready', value }, commitState: 'pending' };
}

/** Rows keyed off a live ChatHub observation: running / waiting / idle(terminal) / unknown(commit-failed). */
function deriveFromObservation(
  observation: ChatObservationSnapshot,
  durableTurn: TurnRow | null,
): ActivityAndExecution {
  const ref: ExecutionRef = { kind: 'chat_turn', nodeId: observation.nodeId, turnId: observation.turnId };

  // Row: "Chat 输出无法提交" — a persistence error was recorded for this turn. This must never
  // read as success, so activity is 'unknown' and execution.status is 'failed' with
  // commitState 'failed', regardless of what durableStatus/inMemoryStatus otherwise say.
  if (observation.lastPersistenceError) {
    const value: ExecutionSnapshot = {
      ref,
      assistantId: observation.assistantId,
      attemptId: null,
      attemptIndex: null,
      status: 'failed',
      startedAt: observation.startedAt,
      endedAt: observation.completedAt ?? observation.lastPersistenceError.occurredAt,
      commitState: 'failed',
      waitingReason: null,
      error: { code: 'PERSISTENCE_FAILED', message: observation.lastPersistenceError.message },
    };
    return { activity: 'unknown', execution: { status: 'ready', value }, commitState: 'failed' };
  }

  // Row: "等待权限/用户输入" — waiting keeps the reason, no on-behalf-of-user approval logic here.
  if (observation.pendingInteraction.waiting) {
    const value: ExecutionSnapshot = {
      ref,
      assistantId: observation.assistantId,
      attemptId: null,
      attemptIndex: null,
      status: 'waiting',
      startedAt: observation.startedAt,
      endedAt: null,
      commitState: 'pending',
      waitingReason: observation.pendingInteraction.reason,
      error: null,
    };
    return { activity: 'waiting', execution: { status: 'ready', value }, commitState: 'pending' };
  }

  // Rows: "ChatHub 活跃 turn" (durableStatus active) and "可见答案结束、后台元信息仍在处理" —
  // both report 'running' with commitState pending; this projection has no signal that
  // distinguishes "still streaming" from "answer visible, terminal record not yet applied"
  // beyond durableStatus, and both map to the same table row (running / pending).
  if (observation.durableStatus === 'active') {
    const value: ExecutionSnapshot = {
      ref,
      assistantId: observation.assistantId,
      attemptId: null,
      attemptIndex: null,
      status: 'running',
      startedAt: observation.startedAt,
      endedAt: null,
      commitState: 'pending',
      waitingReason: null,
      error: null,
    };
    return { activity: 'running', execution: { status: 'ready', value }, commitState: 'pending' };
  }

  // Row: "Chat durable turn completed/error/cancelled" — durableStatus is terminal in this
  // process's own computed snapshot. commitState is 'committed' only once a durable SQLite row
  // for THIS turnId confirms it; otherwise this process's own terminal view is not yet proven
  // durable and commitState stays 'unknown' (never inferred as 'failed').
  const status = terminalExecutionStatus(observation.durableStatus);
  const committedHere = durableTurn?.turn_id === observation.turnId
    && isTerminalTurnRowStatus(durableTurn.status);
  const value: ExecutionSnapshot = {
    ref,
    assistantId: observation.assistantId,
    attemptId: null,
    attemptIndex: null,
    status,
    startedAt: observation.startedAt,
    endedAt: observation.completedAt ?? durableTurn?.completed_at ?? null,
    commitState: committedHere ? 'committed' : 'unknown',
    waitingReason: null,
    error: observation.error ? { code: 'TURN_ERROR', message: observation.error } : null,
  };
  return { activity: 'idle', execution: { status: 'ready', value }, commitState: value.commitState };
}

/** observation === null, durable turn row present: report the durable outcome directly. */
function deriveFromDurableTurnOnly(durableTurn: TurnRow): ActivityAndExecution {
  const ref: ExecutionRef = { kind: 'chat_turn', nodeId: durableTurn.node_id, turnId: durableTurn.turn_id };

  if (!isTerminalTurnRowStatus(durableTurn.status)) {
    // A turn row exists and is still 'active' in SQLite, but this process has no in-memory
    // knowledge of it (e.g. after a restart). There is no authoritative terminal record and no
    // live process to ask, so this is neither 'running' (nothing is actually executing in this
    // process) nor a known terminal outcome.
    const value: ExecutionSnapshot = {
      ref,
      assistantId: durableTurn.assistant_message_id,
      attemptId: null,
      attemptIndex: null,
      status: 'running',
      startedAt: durableTurn.started_at,
      endedAt: null,
      commitState: 'unknown',
      waitingReason: null,
      error: null,
    };
    return { activity: 'unknown', execution: { status: 'ready', value }, commitState: 'unknown' };
  }

  const status = terminalExecutionStatus(durableTurn.status);
  const value: ExecutionSnapshot = {
    ref,
    assistantId: durableTurn.assistant_message_id,
    attemptId: null,
    attemptIndex: null,
    status,
    startedAt: durableTurn.started_at,
    endedAt: durableTurn.completed_at ?? null,
    commitState: 'committed',
    waitingReason: null,
    error: durableTurn.error ? { code: 'TURN_ERROR', message: durableTurn.error } : null,
  };
  return { activity: 'idle', execution: { status: 'ready', value }, commitState: 'committed' };
}

function isTerminalTurnRowStatus(status: TurnRow['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error';
}

/** Maps DurableTurnSnapshot['status'] (active/completed/cancelled/error) onto the public
 *  ExecutionStatus union (completed/failed/cancelled) for a TERMINAL status only. */
function terminalExecutionStatus(status: DurableTurnSnapshot['status']): ExecutionStatus {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'error') return 'failed';
  // Defensive fallback: 'active' is not terminal and should never reach this function; callers
  // gate on isTerminalTurnRowStatus / durableStatus !== 'active' first. Reported as 'running'
  // rather than throwing, since this is a pure projection and must not crash on unexpected input.
  return 'running';
}

// ---------------------------------------------------------------------------
// §6.4 latest output
// ---------------------------------------------------------------------------

function deriveLatestOutput(input: ChatNodeToDescriptorInput): Section<OutputPreview | null> {
  const { observation, durableTurn, previousOutput } = input;

  const currentText = currentAnswerText(observation, durableTurn);

  if (currentText === null) {
    // Row: "当前新 turn 尚未输出时保留上一段预览" — no visible text from the current turn yet;
    // keep the previous turn's preview, stamped with its OWN execution ref so it is never
    // mistaken for this turn's output.
    if (previousOutput) return { status: 'ready', value: previousOutput };
    // No history of any output at all.
    return { status: 'ready', value: null };
  }

  const ref = currentExecutionRef(observation, durableTurn);
  const preview = buildOutputPreview(currentText, ref, currentUpdatedAt(observation, durableTurn), isCurrentTurnActive(observation, durableTurn));
  return { status: 'ready', value: preview };
}

function currentAnswerText(observation: ChatObservationSnapshot | null, durableTurn: TurnRow | null): string | null {
  const raw = observation
    ? answerRawTextFromSnapshot(observation.snapshot)
    : durableTurn
      ? null // TurnRow (the raw DB row) does not carry assistant block content; P1-6 must
              // supply previousOutput / a fetched message body if it wants durable-only text.
      : null;
  if (raw === null) return null;
  const stripped = stripTurnMetadataSentinels(raw);
  return stripped.length > 0 ? stripped : null;
}

function answerRawTextFromSnapshot(snapshot: DurableTurnSnapshot): string {
  return snapshot.assistantMessage.blocks
    .map((block) => (block.kind === 'answer' ? block.rawText : ''))
    .join('');
}

function currentExecutionRef(observation: ChatObservationSnapshot | null, durableTurn: TurnRow | null): ExecutionRef | null {
  if (observation) return { kind: 'chat_turn', nodeId: observation.nodeId, turnId: observation.turnId };
  if (durableTurn) return { kind: 'chat_turn', nodeId: durableTurn.node_id, turnId: durableTurn.turn_id };
  return null;
}

function currentUpdatedAt(observation: ChatObservationSnapshot | null, durableTurn: TurnRow | null): number | null {
  if (observation) return observation.completedAt ?? observation.startedAt;
  if (durableTurn) return durableTurn.completed_at ?? durableTurn.checkpoint_at ?? durableTurn.started_at;
  return null;
}

function isCurrentTurnActive(observation: ChatObservationSnapshot | null, _durableTurn: TurnRow | null): boolean {
  if (observation) return observation.durableStatus === 'active';
  return false;
}

/**
 * Truncates to at most PANE_INSPECTION_LIMITS.outputPreviewBytes of UTF-8, keeping the TAIL,
 * on a whole Unicode code-point boundary. Slicing a JS string by UTF-16 index can split a
 * surrogate pair (breaking an emoji / astral character in half), so this walks code points
 * via Array.from and re-measures UTF-8 byte length rather than trusting string.length.
 */
export function truncateTailToCodePointUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const fullBytes = Buffer.byteLength(text, 'utf8');
  if (fullBytes <= maxBytes) return { text, truncated: false };

  const codePoints = Array.from(text);
  let byteLen = 0;
  let startIndex = codePoints.length;
  // Walk from the end, accumulating UTF-8 byte length per code point, until adding the next
  // (earlier) code point would exceed the budget. This guarantees the kept slice starts and
  // ends on a code-point boundary and never exceeds maxBytes.
  for (let i = codePoints.length - 1; i >= 0; i -= 1) {
    const cp = codePoints[i];
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    if (byteLen + cpBytes > maxBytes) break;
    byteLen += cpBytes;
    startIndex = i;
  }
  return { text: codePoints.slice(startIndex).join(''), truncated: true };
}

export function buildOutputPreview(
  fullText: string,
  ref: ExecutionRef | null,
  updatedAt: number | null,
  partial: boolean,
): OutputPreview {
  const { text, truncated } = truncateTailToCodePointUtf8(fullText, PANE_INSPECTION_LIMITS.outputPreviewBytes);
  return {
    outputId: outputIdFor(ref),
    execution: ref,
    kind: 'answer',
    text,
    outputRevision: outputRevisionFor(fullText, updatedAt),
    updatedAt,
    partial,
    truncated,
  };
}

export function isArchivedPaneNode(node: NodeRow): boolean {
  return node.status === 'archived' || (node.deleted_at !== null && (node.deletion_group_id ?? '').startsWith('arch-'));
}

function outputIdFor(ref: ExecutionRef | null): string {
  if (!ref) return 'no-execution';
  return ref.kind === 'chat_turn' ? `chat_turn:${ref.turnId}` : `agent_run:${ref.runId}`;
}

/** Opaque revision token distinct from the observation cursor — changes whenever the preview
 *  text or its updatedAt changes. Not decoded by any caller; only compared for equality. */
function outputRevisionFor(text: string, updatedAt: number | null): string {
  return `${updatedAt ?? 'null'}:${text.length}:${simpleHash(text)}`;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// observation cursor (§8 boundary token)
// ---------------------------------------------------------------------------

function observationCursor(observation: ChatObservationSnapshot | null, durableTurn: TurnRow | null): string {
  if (observation) return `${observation.cursor.turnId}:${observation.cursor.seq}`;
  if (durableTurn) return `${durableTurn.turn_id}:${durableTurn.last_seq}`;
  return 'none:-1';
}
