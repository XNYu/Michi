/**
 * Versioned public contract for the Pane Inspection API: DTOs, the paneId codec,
 * locator/parameter parsers, event/error contracts and shared limits.
 *
 * See docs/pane-inspection-api-design-2026-09-14.md for the authoritative design.
 * This module is types + pure functions + runtime parsers only — no backend
 * service, no route, no frontend state.
 */

// ---------------------------------------------------------------------------
// Limits (design §11 and the numeric defaults scattered through §5-§9)
// ---------------------------------------------------------------------------

/** Every numeric default/max the design fixes for pane inspection. Named so later
 * tasks import these instead of hardcoding the numbers again. */
export const PANE_INSPECTION_LIMITS = {
  /** §6.4 — latestOutput preview byte cap (UTF-8, truncated at a code point boundary). */
  outputPreviewBytes: 1_024,
  /** §7.3 — read_pane_output default page size in bytes. */
  readOutputDefaultBytes: 16_384,
  /** §7.3 — read_pane_output maximum page size in bytes. */
  readOutputMaxBytes: 65_536,
  /** §7.1 — list_panes default page size. */
  listDefaultLimit: 20,
  /** §7.1 — list_panes maximum page size. */
  listMaxLimit: 100,
  /** §6.3 — lineage.childNodeIds default/maximum count before childrenTruncated. */
  childrenDefaultMax: 100,
  /** §8 — subscribePanes maximum number of paneIds per stream. */
  subscribeMaxPanes: 32,
  /** §7.4 — maximum concurrent wait_pane calls per owner. */
  concurrentWaitsPerOwnerMax: 8,
  /** §7.4 — wait_pane default timeout in milliseconds. */
  waitTimeoutDefaultMs: 20_000,
  /** §7.4 — wait_pane maximum timeout in milliseconds. */
  waitTimeoutMaxMs: 30_000,
  /** §11 — maximum serialized PaneDescriptorV1 size in bytes. */
  descriptorMaxBytes: 32_768,
  /** §8 / §11 — output_changed event coalescing window in milliseconds (terminal flushes immediately). */
  outputChangedCoalesceMs: 250,
  /** §8 — per-object inspection ring retention window in seconds. */
  ringRetentionSeconds: 60,
  /** §8 — per-object inspection ring maximum event count. */
  ringMaxEvents: 256,
  /** §8 — per-object inspection ring maximum size in bytes. */
  ringMaxBytes: 262_144,
  /** §8 — per-workspace inspection ring budget in bytes (LRU-evicted beyond this). */
  workspaceRingBudgetBytes: 4 * 1024 * 1024,
  /** §9 — presence keepalive interval in seconds. */
  presenceKeepaliveSeconds: 20,
  /** §9 — presence lease TTL in seconds. */
  presenceTtlSeconds: 60,
  /** §6.1 — cancel-requested-but-unconfirmed timeout in milliseconds before CANCEL_TIMEOUT is surfaced. */
  cancelTimeoutMs: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Errors (design §11)
// ---------------------------------------------------------------------------

/** Error codes shared by HTTP routes and agent tools (design §11). */
export enum PaneInspectionErrorCode {
  InvalidArgument = 'INVALID_ARGUMENT',
  NotFound = 'NOT_FOUND',
  NavigationDisabled = 'NAVIGATION_DISABLED',
  Unsupported = 'UNSUPPORTED',
  OutputChanged = 'OUTPUT_CHANGED',
  OutputUnavailable = 'OUTPUT_UNAVAILABLE',
  SourceUnavailable = 'SOURCE_UNAVAILABLE',
  RateLimited = 'RATE_LIMITED',
}

/** The one error shape raised by this module's codec and parsers, and shared by
 * the service/routes/tools layers so every raiser carries the same error code. */
export class PaneInspectionError extends Error {
  constructor(readonly code: PaneInspectionErrorCode, readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PaneInspectionError';
  }
}

function fail(code: PaneInspectionErrorCode, path: string, message: string): never {
  throw new PaneInspectionError(code, path, message);
}

function invalid(path: string, message: string): never {
  fail(PaneInspectionErrorCode.InvalidArgument, path, message);
}

// ---------------------------------------------------------------------------
// Core types (design §5)
// ---------------------------------------------------------------------------

export type PaneKind =
  | 'chat' | 'agent-run' | 'digest' | 'artifact'
  | 'launcher' | 'files' | 'review' | 'file' | 'diff'
  | 'terminal' | 'browser';

const PANE_KINDS: readonly PaneKind[] = [
  'chat', 'agent-run', 'digest', 'artifact',
  'launcher', 'files', 'review', 'file', 'diff',
  'terminal', 'browser',
];

/** `ready + value` is a known result (including `ready + null` for "known absent").
 * The non-ready variants carry a required `reason` — callers must never see
 * `unknown`/`unsupported`/`redacted` with no explanation, and must never collapse
 * them into `''`, `0`, `idle` or an empty array. */
export type Section<T> =
  | { status: 'ready'; value: T }
  | { status: 'unknown' | 'unsupported' | 'redacted'; reason: string };

export interface PaneRef {
  backendConnectionId: string;
  paneId: string;
}

export type PaneTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'agent_run'; runId: string }
  | { kind: 'surface'; registrationId: string };

export type ExecutionRef =
  | { kind: 'chat_turn'; nodeId: string; turnId: string }
  | { kind: 'agent_run'; runId: string };

export type ExecutionStatus =
  | 'queued' | 'preparing' | 'running' | 'waiting'
  | 'recovering' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'queued', 'preparing', 'running', 'waiting',
  'recovering', 'cancelling', 'completed', 'failed', 'cancelled',
];

export type CommitState = 'pending' | 'committed' | 'failed' | 'unknown';

export interface ExecutionSnapshot {
  ref: ExecutionRef;
  assistantId: string | null;
  attemptId: string | null;
  attemptIndex: number | null;
  status: ExecutionStatus;
  startedAt: number | null;
  endedAt: number | null;
  commitState: CommitState;
  waitingReason: string | null;
  error: { code: string; message: string } | null;
}

export interface OutputPreview {
  outputId: string;
  execution: ExecutionRef | null;
  kind: 'answer' | 'handoff';
  text: string;
  /** Opaque token identifying this snapshot of the output content. Changes when
   * text changes; distinct from the observation cursor used for subscriptions. */
  outputRevision: string;
  updatedAt: number | null;
  partial: boolean;
  truncated: boolean;
}

export type PaneActivity =
  | 'unstarted' | 'queued' | 'preparing' | 'running'
  | 'waiting' | 'recovering' | 'cancelling' | 'idle'
  | 'unknown' | 'not_applicable';

const PANE_ACTIVITIES: readonly PaneActivity[] = [
  'unstarted', 'queued', 'preparing', 'running',
  'waiting', 'recovering', 'cancelling', 'idle',
  'unknown', 'not_applicable',
];

export type ObservationFreshness = 'live' | 'persisted' | 'stale';

export interface PaneDescriptorV1 {
  version: 1;
  ref: PaneRef;
  target: PaneTarget;
  kind: PaneKind;
  title: string;
  workspaceId: string;
  treeId: string | null;
  archived: boolean;
  /** Dotted field paths trimmed for response-size limits, e.g. `presence.views`.
   * Identity, execution refs, status and cursor are never truncated. */
  truncatedFields: string[];
  observation: {
    observedAt: number;
    freshness: ObservationFreshness;
    cursor: string;
  };
  capabilities: {
    readOutput: boolean;
    subscribe: boolean;
    waitForTerminal: boolean;
  };
  activity: PaneActivity;
  execution: Section<ExecutionSnapshot | null>;
  timeline: {
    resourceCreatedAt: number | null;
    firstExecutionStartedAt: number | null;
  };
  presence: {
    coverage: 'reported' | 'unknown';
    views: Array<{
      windowId: string;
      uiPaneId: string;
      treeId: string | null;
      visible: boolean;
      openedAtClient: number | null;
      registeredAt: number;
      lastSeenAt: number;
    }>;
  };
  conversation: Section<{
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    completedTurnCount: number | null;
    turnHistoryCoverage: 'complete' | 'partial';
  }>;
  lineage: Section<{
    parentNodeId: string | null;
    parentRunId: string | null;
    originMessageId: string | null;
    treeRootNodeId: string | null;
    childNodeIds: string[];
    childrenTruncated: boolean;
  }>;
  runtime: Section<{
    runtimeId: string | null;
    modelId: string | null;
    providerId: string | null;
    contextUsagePercentage: number | null;
  }>;
  latestOutput: Section<OutputPreview | null>;
}

// ---------------------------------------------------------------------------
// API parameter types (design §7)
// ---------------------------------------------------------------------------

export type PaneListScope = 'open' | 'all';
export type OutputSelection = 'latest' | 'last_completed' | 'execution';
export type WaitUntil = 'changed' | 'terminal';
export type WaitReason = 'changed' | 'terminal' | 'timed_out' | 'unavailable';

const PANE_LIST_SCOPES: readonly PaneListScope[] = ['open', 'all'];
const OUTPUT_SELECTIONS: readonly OutputSelection[] = ['latest', 'last_completed', 'execution'];
const WAIT_UNTILS: readonly WaitUntil[] = ['changed', 'terminal'];
const WAIT_REASONS: readonly WaitReason[] = ['changed', 'terminal', 'timed_out', 'unavailable'];

/** The three mutually-exclusive ways to locate a pane. Exactly one must be present. */
export type PaneLocator =
  | { paneId: string }
  | { nodeId: string }
  | { runId: string };

export interface ListPanesParamsV1 {
  workspaceId: string;
  treeId?: string | null;
  kind?: PaneKind;
  parentNodeId?: string | null;
  scope: PaneListScope;
  includeArchived: boolean;
  limit: number;
  cursor?: string | null;
}

export interface InspectPaneParamsV1 {
  locator: PaneLocator;
  executionRef?: ExecutionRef | null;
}

export interface ReadPaneOutputParamsV1 {
  locator: PaneLocator;
  selection: OutputSelection;
  executionRef?: ExecutionRef | null;
  outputId?: string | null;
  pageCursor?: string | null;
  limitBytes: number;
}

export interface SubscribePanesParamsV1 {
  /** paneId → observation cursor most recently received for that pane, if any. */
  panes: Array<{ paneId: string; cursor?: string | null }>;
}

export interface WaitPaneParamsV1 {
  locator: PaneLocator;
  until: WaitUntil;
  /** Required observation cursor for `until: 'changed'`. */
  cursor?: string | null;
  /** Required execution reference for `until: 'terminal'`. */
  executionRef?: ExecutionRef | null;
  timeoutMs: number;
}

export interface WaitPaneResultV1 {
  reason: WaitReason;
  snapshot: PaneDescriptorV1 | null;
  execution: ExecutionSnapshot | null;
  cursor: string | null;
}

/** Compact per-pane summary returned by list_panes. Deliberately excludes output body. */
export interface PaneSummaryV1 {
  ref: PaneRef;
  kind: PaneKind;
  title: string;
  activity: PaneActivity;
  latestExecution: { ref: ExecutionRef; status: ExecutionStatus } | null;
  openedInViews: number;
  updatedAt: number;
}

export interface ListPanesResultV1 {
  panes: PaneSummaryV1[];
  nextCursor: string | null;
  presenceCoverage: 'reported' | 'unknown';
}

// ---------------------------------------------------------------------------
// Feed event types (design §8)
// ---------------------------------------------------------------------------

export type PaneFeedEventType =
  | 'snapshot' | 'changed' | 'output_changed' | 'execution_settled'
  | 'removed' | 'access_revoked' | 'resync_required' | 'heartbeat';

interface PaneFeedEventBase {
  version: 1;
  paneId: string;
  cursor: string;
  emittedAt: number;
}

export type PaneFeedEventV1 =
  | (PaneFeedEventBase & { type: 'snapshot'; descriptor: PaneDescriptorV1 })
  | (PaneFeedEventBase & { type: 'changed'; changedSections: string[]; descriptor: PaneDescriptorV1 })
  | (PaneFeedEventBase & { type: 'output_changed'; outputId: string; outputRevision: string; preview: OutputPreview })
  | (PaneFeedEventBase & { type: 'execution_settled'; execution: ExecutionRef; status: ExecutionStatus; commitState: CommitState })
  | (PaneFeedEventBase & { type: 'removed' })
  | (PaneFeedEventBase & { type: 'access_revoked' })
  | (PaneFeedEventBase & { type: 'resync_required' })
  | (PaneFeedEventBase & { type: 'heartbeat' });

// ---------------------------------------------------------------------------
// ID codec (design §4.1.1)
// ---------------------------------------------------------------------------

const PANE_ID_PREFIXES = {
  node: 'node:',
  agent_run: 'run:',
  surface: 'surface:',
} as const;

/** Encode a `PaneTarget` into the opaque, prefixed public `paneId` string.
 *
 * `run:` segments (`backendConnectionId`, `runId`) are each `encodeURIComponent`-
 * encoded so a `:` or `/` inside either segment cannot be confused with the
 * codec's own `:` separators. This mirrors the existing frontend
 * `agentRunPaneId(backendConnectionId, runId)` in `frontend/src/state/paneItems.ts`,
 * which already builds `pane:agent-run:<enc>:<enc>` the same way — later tasks
 * mapping between the two ID spaces can rely on both using the same encoding. */
export function encodePaneId(target: PaneTarget): string {
  if (target.kind === 'node') return `${PANE_ID_PREFIXES.node}${target.nodeId}`;
  if (target.kind === 'agent_run') {
    return `${PANE_ID_PREFIXES.agent_run}${encodeURIComponent(target.runId)}`;
  }
  return `${PANE_ID_PREFIXES.surface}${target.registrationId}`;
}

/** Encode a `run:` paneId from its two source segments before URI-encoding.
 * Exported so callers that only have `backendConnectionId`/`runId` (rather than
 * a full `PaneTarget`) do not need to reconstruct the union just to encode. */
export function encodeAgentRunPaneId(backendConnectionId: string, runId: string): string {
  return `${PANE_ID_PREFIXES.agent_run}${encodeURIComponent(backendConnectionId)}:${encodeURIComponent(runId)}`;
}

function rejectWhitespace(id: string, path: string): void {
  if (id !== id.trim()) invalid(path, 'must not have leading or trailing whitespace');
}

function rejectEmptySegment(segment: string, path: string): string {
  if (!segment) invalid(path, 'must not be empty');
  return segment;
}

/** Real runtime parser for the opaque public `paneId` — not a cast. Rejects an
 * unknown or missing prefix, an empty id segment, the wrong segment count for
 * the prefix, and leading/trailing whitespace. Throws `PaneInspectionError`
 * with `INVALID_ARGUMENT` on any rejection. */
export function decodePaneId(paneId: string, path = 'paneId'): PaneTarget {
  if (typeof paneId !== 'string') invalid(path, 'must be a string');
  rejectWhitespace(paneId, path);
  if (!paneId) invalid(path, 'must not be empty');

  if (paneId.startsWith(PANE_ID_PREFIXES.node)) {
    const nodeId = rejectEmptySegment(paneId.slice(PANE_ID_PREFIXES.node.length), path);
    return { kind: 'node', nodeId };
  }
  if (paneId.startsWith(PANE_ID_PREFIXES.agent_run)) {
    const rest = paneId.slice(PANE_ID_PREFIXES.agent_run.length);
    const parts = rest.split(':');
    if (parts.length < 1 || parts.length > 2) {
      invalid(path, 'run: paneId must have one or two colon-separated segments');
    }
    const encRunId = parts[parts.length - 1]!;
    rejectEmptySegment(encRunId, path);
    let runId: string;
    try {
      // A composite gateway ID carries backendConnectionId first. PaneTarget is
      // backend-scoped, so the generic decoder validates that segment but only
      // returns the runId. decodeAgentRunPaneId recovers both values when needed.
      if (parts.length === 2) {
        rejectEmptySegment(parts[0]!, path);
        rejectEmptySegment(decodeURIComponent(parts[0]!), path);
      }
      runId = decodeURIComponent(encRunId);
    } catch {
      invalid(path, 'run: paneId segments must be valid percent-encoded strings');
    }
    return { kind: 'agent_run', runId: rejectEmptySegment(runId, path) };
  }
  if (paneId.startsWith(PANE_ID_PREFIXES.surface)) {
    const registrationId = rejectEmptySegment(paneId.slice(PANE_ID_PREFIXES.surface.length), path);
    return { kind: 'surface', registrationId };
  }
  invalid(path, 'must start with a recognized prefix (node:, run:, surface:)');
}

/** Decode a `run:` paneId into both of its source segments, including the
 * `backendConnectionId` that `decodePaneId`/`PaneTarget` intentionally discards
 * (design §4.1.1: the target itself is backend-scoped; the connection id is
 * routing information the caller/gateway already has). */
export function decodeAgentRunPaneId(paneId: string, path = 'paneId'): { backendConnectionId: string; runId: string } {
  if (typeof paneId !== 'string') invalid(path, 'must be a string');
  rejectWhitespace(paneId, path);
  if (!paneId.startsWith(PANE_ID_PREFIXES.agent_run)) invalid(path, 'must start with run:');
  const rest = paneId.slice(PANE_ID_PREFIXES.agent_run.length);
  const parts = rest.split(':');
  if (parts.length !== 2) invalid(path, 'run: paneId must have exactly two colon-separated segments');
  const [encConnId, encRunId] = parts;
  rejectEmptySegment(encConnId, path);
  rejectEmptySegment(encRunId, path);
  let backendConnectionId: string;
  let runId: string;
  try {
    backendConnectionId = decodeURIComponent(encConnId);
    runId = decodeURIComponent(encRunId);
  } catch {
    invalid(path, 'run: paneId segments must be valid percent-encoded strings');
  }
  return { backendConnectionId: rejectEmptySegment(backendConnectionId, path), runId: rejectEmptySegment(runId, path) };
}

// ---------------------------------------------------------------------------
// Parsers for untrusted input (design §7)
// ---------------------------------------------------------------------------

function str(value: unknown, path: string, max = 4_096, empty = false): string {
  if (typeof value !== 'string') invalid(path, 'must be a string');
  const out = value as string;
  if (!empty && !out.trim()) invalid(path, 'must not be empty');
  if (out.length > max) invalid(path, `must be at most ${max} characters`);
  return out;
}

function nullableStr(value: unknown, path: string, max = 4_096): string | null {
  return value === null || value === undefined ? null : str(value, path, max);
}

function choice<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    invalid(path, `must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean');
  return value;
}

/** Clamp an untrusted numeric bound to `[min, max]`, defaulting when omitted.
 * Rejects non-integers rather than silently coercing them. */
function clampInt(value: unknown, path: string, options: { min: number; max: number; defaultValue: number }): number {
  const { min, max, defaultValue } = options;
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    invalid(path, 'must be an integer');
  }
  return Math.min(max, Math.max(min, value as number));
}

/** Parse the three mutually-exclusive locator parameters (`paneId` | `nodeId` |
 * `runId`). Exactly one must be present; two or zero is INVALID_ARGUMENT. */
export function parsePaneLocator(value: unknown, path = 'locator'): PaneLocator {
  const raw = (value ?? {}) as Record<string, unknown>;
  const hasPaneId = raw.paneId !== undefined && raw.paneId !== null && raw.paneId !== '';
  const hasNodeId = raw.nodeId !== undefined && raw.nodeId !== null && raw.nodeId !== '';
  const hasRunId = raw.runId !== undefined && raw.runId !== null && raw.runId !== '';
  const count = Number(hasPaneId) + Number(hasNodeId) + Number(hasRunId);
  if (count !== 1) invalid(path, 'must specify exactly one of paneId, nodeId, or runId');
  if (hasPaneId) return { paneId: str(raw.paneId, `${path}.paneId`) };
  if (hasNodeId) return { nodeId: str(raw.nodeId, `${path}.nodeId`) };
  return { runId: str(raw.runId, `${path}.runId`) };
}

/** Parse an `ExecutionRef` (both variants). */
export function parseExecutionRef(value: unknown, path = 'executionRef'): ExecutionRef {
  const raw = (value ?? {}) as Record<string, unknown>;
  const kind = choice(raw.kind, ['chat_turn', 'agent_run'] as const, `${path}.kind`);
  if (kind === 'chat_turn') {
    return {
      kind,
      nodeId: str(raw.nodeId, `${path}.nodeId`),
      turnId: str(raw.turnId, `${path}.turnId`),
    };
  }
  return { kind, runId: str(raw.runId, `${path}.runId`) };
}

export function parsePaneKind(value: unknown, path = 'kind'): PaneKind {
  return choice(value, PANE_KINDS, path);
}

export function parsePaneListScope(value: unknown, path = 'scope'): PaneListScope {
  return choice(value, PANE_LIST_SCOPES, path);
}

export function parseOutputSelection(value: unknown, path = 'selection'): OutputSelection {
  return choice(value, OUTPUT_SELECTIONS, path);
}

export function parseWaitUntil(value: unknown, path = 'until'): WaitUntil {
  return choice(value, WAIT_UNTILS, path);
}

export function parseWaitReason(value: unknown, path = 'reason'): WaitReason {
  return choice(value, WAIT_REASONS, path);
}

export function parsePaneActivity(value: unknown, path = 'activity'): PaneActivity {
  return choice(value, PANE_ACTIVITIES, path);
}

export function parseExecutionStatus(value: unknown, path = 'status'): ExecutionStatus {
  return choice(value, EXECUTION_STATUSES, path);
}

/** Clamp `limit` to `[1, listMaxLimit]`, defaulting to `listDefaultLimit`. */
export function parseListLimit(value: unknown, path = 'limit'): number {
  return clampInt(value, path, { min: 1, max: PANE_INSPECTION_LIMITS.listMaxLimit, defaultValue: PANE_INSPECTION_LIMITS.listDefaultLimit });
}

/** Clamp `limitBytes` to `[1, readOutputMaxBytes]`, defaulting to `readOutputDefaultBytes`. */
export function parseReadOutputLimitBytes(value: unknown, path = 'limitBytes'): number {
  return clampInt(value, path, { min: 1, max: PANE_INSPECTION_LIMITS.readOutputMaxBytes, defaultValue: PANE_INSPECTION_LIMITS.readOutputDefaultBytes });
}

/** Clamp `timeoutMs` to `[1, waitTimeoutMaxMs]`, defaulting to `waitTimeoutDefaultMs`. */
export function parseWaitTimeoutMs(value: unknown, path = 'timeoutMs'): number {
  return clampInt(value, path, { min: 1, max: PANE_INSPECTION_LIMITS.waitTimeoutMaxMs, defaultValue: PANE_INSPECTION_LIMITS.waitTimeoutDefaultMs });
}

export function parseListPanesParamsV1(value: unknown, path = 'params'): ListPanesParamsV1 {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    workspaceId: str(raw.workspaceId, `${path}.workspaceId`),
    ...(raw.treeId === undefined ? {} : { treeId: nullableStr(raw.treeId, `${path}.treeId`) }),
    ...(raw.kind === undefined ? {} : { kind: parsePaneKind(raw.kind, `${path}.kind`) }),
    ...(raw.parentNodeId === undefined ? {} : { parentNodeId: nullableStr(raw.parentNodeId, `${path}.parentNodeId`) }),
    scope: raw.scope === undefined ? 'open' : parsePaneListScope(raw.scope, `${path}.scope`),
    includeArchived: raw.includeArchived === undefined ? false : bool(raw.includeArchived, `${path}.includeArchived`),
    limit: parseListLimit(raw.limit, `${path}.limit`),
    ...(raw.cursor === undefined ? {} : { cursor: nullableStr(raw.cursor, `${path}.cursor`) }),
  };
}

export function parseInspectPaneParamsV1(value: unknown, path = 'params'): InspectPaneParamsV1 {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    locator: parsePaneLocator(raw, `${path}`),
    ...(raw.executionRef === undefined || raw.executionRef === null
      ? {}
      : { executionRef: parseExecutionRef(raw.executionRef, `${path}.executionRef`) }),
  };
}

export function parseReadPaneOutputParamsV1(value: unknown, path = 'params'): ReadPaneOutputParamsV1 {
  const raw = (value ?? {}) as Record<string, unknown>;
  const selection = parseOutputSelection(raw.selection, `${path}.selection`);
  const executionRef = raw.executionRef === undefined || raw.executionRef === null
    ? null
    : parseExecutionRef(raw.executionRef, `${path}.executionRef`);
  if (selection === 'execution' && executionRef === null) {
    invalid(`${path}.executionRef`, 'is required when selection is "execution"');
  }
  return {
    locator: parsePaneLocator(raw, `${path}`),
    selection,
    executionRef,
    outputId: raw.outputId === undefined ? null : nullableStr(raw.outputId, `${path}.outputId`),
    pageCursor: raw.pageCursor === undefined ? null : nullableStr(raw.pageCursor, `${path}.pageCursor`),
    limitBytes: parseReadOutputLimitBytes(raw.limitBytes, `${path}.limitBytes`),
  };
}

export function parseSubscribePanesParamsV1(value: unknown, path = 'params'): SubscribePanesParamsV1 {
  const raw = (value ?? {}) as Record<string, unknown>;
  const rawPanes = raw.panes;
  if (!Array.isArray(rawPanes)) invalid(`${path}.panes`, 'must be an array');
  if (rawPanes.length === 0) invalid(`${path}.panes`, 'must not be empty');
  if (rawPanes.length > PANE_INSPECTION_LIMITS.subscribeMaxPanes) {
    invalid(`${path}.panes`, `must contain at most ${PANE_INSPECTION_LIMITS.subscribeMaxPanes} panes`);
  }
  const panes = rawPanes.map((item, i) => {
    const p = `${path}.panes[${i}]`;
    const entry = (item ?? {}) as Record<string, unknown>;
    return {
      paneId: str(entry.paneId, `${p}.paneId`),
      ...(entry.cursor === undefined ? {} : { cursor: nullableStr(entry.cursor, `${p}.cursor`) }),
    };
  });
  if (new Set(panes.map((p) => p.paneId)).size !== panes.length) {
    invalid(`${path}.panes`, 'must not contain duplicate paneIds');
  }
  return { panes };
}

export function parseWaitPaneParamsV1(value: unknown, path = 'params'): WaitPaneParamsV1 {
  const raw = (value ?? {}) as Record<string, unknown>;
  const until = parseWaitUntil(raw.until, `${path}.until`);
  const cursor = raw.cursor === undefined ? null : nullableStr(raw.cursor, `${path}.cursor`);
  const executionRef = raw.executionRef === undefined || raw.executionRef === null
    ? null
    : parseExecutionRef(raw.executionRef, `${path}.executionRef`);
  if (until === 'changed' && !cursor) invalid(`${path}.cursor`, 'is required when until is "changed"');
  if (until === 'terminal' && executionRef === null) invalid(`${path}.executionRef`, 'is required when until is "terminal"');
  return {
    locator: parsePaneLocator(raw, `${path}`),
    until,
    cursor,
    executionRef,
    timeoutMs: parseWaitTimeoutMs(raw.timeoutMs, `${path}.timeoutMs`),
  };
}
