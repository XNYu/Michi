/** Pure projection: AgentRun (Run + Attempts + events) -> PaneDescriptorV1. §5.1/§6.1/§6.4.
 *  No repository calls, no event-bus subscription, no Date.now() inside — P1-6 fetches, this maps. */
import {
  AgentRunEventType,
  AgentRunStatus,
  AgentRunWaitingReason,
  type AgentRunAttemptDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
} from 'michi-shared';
import type {
  ExecutionSnapshot,
  ExecutionStatus,
  OutputPreview,
  PaneActivity,
  PaneDescriptorV1,
} from 'michi-shared';
import { PANE_INSPECTION_LIMITS } from 'michi-shared';
import { compactResultHandoff } from '../agents/runs/resultBundle';

/** Cancellation-related events for the SELECTED attempt/run, needed to derive `cancelling` per
 *  §6.1 — CancellationRequested with no subsequent terminal RunStatusChanged means "cancelling".
 *  Extending the suggested input shape: the brief's sketch omitted these, but deriving
 *  `cancelling` is impossible without them (no `cancelling` value exists in AgentRunStatus). */
export interface AgentRunCancellationEventsInput {
  /** All CancellationRequested events observed for this Run (usually 0 or 1; idempotent retries
   *  with the same operationId do not append a second one, per agentRunCoordinator.ts). */
  cancellationRequested: AgentRunEventV1[];
}

export interface AgentRunProjectionInput {
  run: AgentRunDtoV1;
  /** All attempts, ordered by attemptIndex. */
  attempts: AgentRunAttemptDtoV1[];
  /** Assistant events already filtered to the SELECTED attempt (the Run's activeAttemptId, or the
   *  caller's chosen attempt for a terminal Run) — never spans more than one attemptId. */
  assistantEvents: AgentRunEventV1[];
  /** See AgentRunCancellationEventsInput — added beyond the brief's suggested shape. */
  cancellation: AgentRunCancellationEventsInput;
  presence: PaneDescriptorV1['presence'];
  backendConnectionId: string;
  observedAt: number;
}

const RUN_STATUS_TO_ACTIVITY: Partial<Record<AgentRunStatus, PaneActivity>> = {
  [AgentRunStatus.Queued]: 'queued',
  [AgentRunStatus.Preparing]: 'preparing',
  [AgentRunStatus.Running]: 'running',
  [AgentRunStatus.Waiting]: 'waiting',
  [AgentRunStatus.Recovering]: 'recovering',
};

const RUN_STATUS_TO_EXECUTION_STATUS: Record<AgentRunStatus, ExecutionStatus> = {
  [AgentRunStatus.Queued]: 'queued',
  [AgentRunStatus.Preparing]: 'preparing',
  [AgentRunStatus.Running]: 'running',
  [AgentRunStatus.Waiting]: 'waiting',
  [AgentRunStatus.Recovering]: 'recovering',
  [AgentRunStatus.Completed]: 'completed',
  [AgentRunStatus.Failed]: 'failed',
  [AgentRunStatus.Cancelled]: 'cancelled',
};

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  AgentRunStatus.Completed,
  AgentRunStatus.Failed,
  AgentRunStatus.Cancelled,
]);

const WAITING_REASON_TEXT: Record<AgentRunWaitingReason, string> = {
  [AgentRunWaitingReason.Permission]: 'permission',
  [AgentRunWaitingReason.Context]: 'context',
  [AgentRunWaitingReason.UserInput]: 'user_input',
  [AgentRunWaitingReason.ParentInput]: 'parent_input',
};

/** §6.1: cancelling is derived from CancellationRequested with no subsequent terminal status —
 *  never from AgentRunStatus (which has no cancelling value) and never inferred from a timeout. */
function deriveCancelling(input: {
  run: AgentRunDtoV1;
  cancellationRequested: AgentRunEventV1[];
  observedAt: number;
}): { cancelling: boolean; requestedAt: number | null; timedOut: boolean } {
  if (input.cancellationRequested.length === 0) return { cancelling: false, requestedAt: null, timedOut: false };
  if (TERMINAL_RUN_STATUSES.has(input.run.status)) {
    // Authoritative terminal status has arrived — no longer cancelling, whatever the outcome.
    return { cancelling: false, requestedAt: null, timedOut: false };
  }
  // Take the earliest request's createdAt as the cancellation clock start (idempotent duplicate
  // requests for the same operation do not get appended per agentRunCoordinator.ts, but defend
  // against multiple distinct requests anyway by taking the earliest).
  const requestedAt = input.cancellationRequested.reduce(
    (min, event) => (min === null || event.createdAt < min ? event.createdAt : min),
    null as number | null,
  );
  const timedOut = requestedAt !== null && input.observedAt - requestedAt > PANE_INSPECTION_LIMITS.cancelTimeoutMs;
  return { cancelling: true, requestedAt, timedOut };
}

function activityForRun(run: AgentRunDtoV1, cancelling: boolean): PaneActivity {
  if (cancelling) return 'cancelling';
  if (TERMINAL_RUN_STATUSES.has(run.status)) return 'idle'; // idle never means success — see execution.status
  return RUN_STATUS_TO_ACTIVITY[run.status] ?? 'unknown';
}

function selectedAttempt(run: AgentRunDtoV1, attempts: readonly AgentRunAttemptDtoV1[]): AgentRunAttemptDtoV1 | null {
  if (run.activeAttemptId) {
    const active = attempts.find((attempt) => attempt.id === run.activeAttemptId);
    if (active) return active;
  }
  // No active attempt (e.g. terminal Run past active tracking, or never attempted) — fall back to
  // the highest attemptIndex, which is the most recent attempt.
  if (attempts.length === 0) return null;
  return attempts.reduce((latest, attempt) => (attempt.attemptIndex > latest.attemptIndex ? attempt : latest));
}

/** UTF-8 byte-safe truncation to at most `maxBytes`, never splitting a multi-byte code point. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return { text, truncated: false };
  // Walk backwards from the byte cap to the start of the last complete UTF-8 code point.
  let end = maxBytes;
  // Continuation bytes have the high bits 10xxxxxx (0x80-0xBF); back up over them to the lead byte.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

function assistantTextForAttempt(events: readonly AgentRunEventV1[], attemptId: string | null): string {
  // §6.4: aggregate assistant text WITHIN ONE ATTEMPT ONLY — never concatenate across attempts.
  // Input is already filtered to the selected attempt by the caller (P1-6); re-filter defensively
  // so a caller that passes unfiltered events cannot leak cross-attempt text into the preview.
  return events
    .filter((event) => event.type === AgentRunEventType.Assistant && event.attemptId === attemptId)
    .map((event) => {
      const payload = event.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.text === 'string') {
        return payload.text;
      }
      return '';
    })
    .join('');
}

function buildLatestOutput(input: {
  run: AgentRunDtoV1;
  attempt: AgentRunAttemptDtoV1 | null;
  assistantEvents: readonly AgentRunEventV1[];
}): PaneDescriptorV1['latestOutput'] {
  const { run, attempt } = input;
  if (TERMINAL_RUN_STATUSES.has(run.status) && run.resultBundle) {
    const text = compactResultHandoff(run.resultBundle);
    const { text: bounded, truncated } = truncateUtf8(text, PANE_INSPECTION_LIMITS.outputPreviewBytes);
    const preview: OutputPreview = {
      outputId: `run-handoff:${run.id}`,
      execution: { kind: 'agent_run', runId: run.id },
      kind: 'handoff',
      text: bounded,
      outputRevision: `${run.id}:${run.completedAt ?? run.latestEventSeq}`,
      updatedAt: run.completedAt,
      partial: false,
      truncated,
    };
    return { status: 'ready', value: preview };
  }

  if (!attempt) {
    // No attempt yet (e.g. still queued) — known to be absent, not unknown.
    return { status: 'ready', value: null };
  }

  const rawText = assistantTextForAttempt(input.assistantEvents, attempt.id);
  if (!rawText) return { status: 'ready', value: null };

  const { text: bounded, truncated } = truncateUtf8(rawText, PANE_INSPECTION_LIMITS.outputPreviewBytes);
  const preview: OutputPreview = {
    outputId: `run-attempt:${attempt.id}`,
    execution: { kind: 'agent_run', runId: run.id },
    kind: 'answer',
    text: bounded,
    outputRevision: `${attempt.id}:${run.latestEventSeq}`,
    updatedAt: attempt.checkpointAt ?? attempt.startedAt,
    partial: !TERMINAL_RUN_STATUSES.has(run.status),
    truncated,
  };
  return { status: 'ready', value: preview };
}

function buildExecution(input: {
  run: AgentRunDtoV1;
  attempt: AgentRunAttemptDtoV1 | null;
  cancelling: boolean;
  timedOut: boolean;
}): PaneDescriptorV1['execution'] {
  const { run, attempt, cancelling, timedOut } = input;
  const snapshot: ExecutionSnapshot = {
    ref: { kind: 'agent_run', runId: run.id },
    assistantId: null,
    // attemptId/attemptIndex describe the CURRENT attempt as information only — a failed attempt
    // followed by `recovering` is not a failed Run (§6.1); the Run's own status/error carries the
    // real outcome below, never the attempt's.
    attemptId: attempt?.id ?? null,
    attemptIndex: attempt?.attemptIndex ?? null,
    status: cancelling ? 'cancelling' : RUN_STATUS_TO_EXECUTION_STATUS[run.status],
    startedAt: run.startedAt,
    endedAt: run.completedAt,
    commitState: TERMINAL_RUN_STATUSES.has(run.status) ? 'committed' : 'pending',
    waitingReason: run.waitingReason ? WAITING_REASON_TEXT[run.waitingReason] : null,
    error: timedOut
      ? { code: 'CANCEL_TIMEOUT', message: 'Cancellation was requested but no terminal status arrived within the timeout.' }
      : null,
  };
  return { status: 'ready', value: snapshot };
}

function buildRuntime(run: AgentRunDtoV1): PaneDescriptorV1['runtime'] {
  // §8: map only runtime.runtimeId / modelId / providerId from the resolved runtime profile.
  // Never expose capabilitySnapshot, credentialBindingIds, executionEnvironment, or permission
  // policy — those live in effectiveDefinition but must never reach the DTO.
  const profile = run.effectiveDefinition.runtimeProfile;
  return {
    status: 'ready',
    value: {
      runtimeId: profile.runtimeId,
      modelId: profile.modelId ?? null,
      providerId: profile.providerId ?? null,
      contextUsagePercentage: null,
    },
  };
}

/** Maps an AgentRun (Run + Attempts + events) to a PaneDescriptorV1. Pure: no I/O, no clock reads
 *  — `observedAt` is supplied by the caller. */
export function agentRunToDescriptor(input: AgentRunProjectionInput): PaneDescriptorV1 {
  const { run, attempts, assistantEvents, cancellation, presence, backendConnectionId, observedAt } = input;

  const { cancelling, timedOut } = deriveCancelling({
    run,
    cancellationRequested: cancellation.cancellationRequested,
    observedAt,
  });
  const attempt = selectedAttempt(run, attempts);

  return {
    version: 1,
    ref: { backendConnectionId, paneId: `run:${encodeURIComponent(run.id)}` },
    target: { kind: 'agent_run', runId: run.id },
    kind: 'agent-run',
    title: run.effectiveDefinition.name,
    workspaceId: run.workspaceId,
    treeId: null, // AgentRuns are not tied to a chat tree; §5.1 leaves this null for the Run adapter.
    archived: run.archivedAt !== null,
    truncatedFields: [],
    observation: {
      observedAt,
      freshness: 'live',
      cursor: `${run.id}:${run.latestEventSeq}`,
    },
    capabilities: {
      readOutput: true,
      subscribe: true,
      waitForTerminal: true,
    },
    activity: activityForRun(run, cancelling),
    execution: buildExecution({ run, attempt, cancelling, timedOut }),
    timeline: {
      resourceCreatedAt: run.createdAt,
      firstExecutionStartedAt: run.startedAt,
    },
    presence,
    // §6.1/§5.1: first release does not promise a turn count for Runs — never substitute event
    // count, token-chunk count or attempt count for a message count.
    conversation: {
      status: 'unsupported',
      reason: 'AgentRun does not have a message-turn model in the first release; use latestOutput for content.',
    },
    // Lineage for a Run comes from ParentInvocationAnchorV1, but resolving parent titles/lineage
    // chains requires repository access this pure module does not have — P1-6 (the fetching layer)
    // owns joining parentRunId/parentNodeId into a PaneLineageSummary. This module reports
    // unsupported rather than guessing to avoid inventing success (COMMON.md rule 8).
    lineage: {
      status: 'unsupported',
      reason: 'Run lineage resolution requires repository access; not available in a pure projection.',
    },
    runtime: buildRuntime(run),
    latestOutput: buildLatestOutput({ run, attempt, assistantEvents }),
  };
}
