/** Versioned public contract for the Pane Inspection API: DTOs, ID codec, parsers, error codes and limits.
 *  Design: docs/pane-inspection-api-design-2026-09-14.md */

// ---------------------------------------------------------------------------
// §5 Core data contract
// ---------------------------------------------------------------------------

export type PaneKind =
  | 'chat' | 'agent-run' | 'digest' | 'artifact'
  | 'launcher' | 'files' | 'review' | 'file' | 'diff'
  | 'terminal' | 'browser';

export const PANE_KINDS: readonly PaneKind[] = [
  'chat', 'agent-run', 'digest', 'artifact',
  'launcher', 'files', 'review', 'file', 'diff',
  'terminal', 'browser',
];

/** ready+value: known present. ready+null: known absent. unknown/unsupported/redacted MUST carry
 *  a reason — never collapse a non-ready state into '', 0, 'idle' or an empty array. */
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

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
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

export type OutputKind = 'answer' | 'handoff';

export interface OutputPreview {
  outputId: string;
  execution: ExecutionRef | null;
  kind: OutputKind;
  text: string;
  /** Opaque token identifying this snapshot of the output content.
   *  Changes when text changes; distinct from the observation cursor. */
  outputRevision: string;
  updatedAt: number | null;
  partial: boolean;
  truncated: boolean;
}

/** activity is deliberately a different union from ExecutionSnapshot.status — do not merge or
 *  alias them. activity adds unstarted/idle/unknown/not_applicable; status adds
 *  completed/failed/cancelled. */
export type PaneActivity =
  | 'unstarted' | 'queued' | 'preparing' | 'running'
  | 'waiting' | 'recovering' | 'cancelling' | 'idle'
  | 'unknown' | 'not_applicable';

export const PANE_ACTIVITIES: readonly PaneActivity[] = [
  'unstarted', 'queued', 'preparing', 'running',
  'waiting', 'recovering', 'cancelling', 'idle',
  'unknown', 'not_applicable',
];

export type ObservationFreshness = 'live' | 'persisted' | 'stale';

export interface PaneViewV1 {
  windowId: string;
  uiPaneId: string;
  treeId: string | null;
  visible: boolean;
  openedAtClient: number | null;
  registeredAt: number;
  lastSeenAt: number;
}

export interface PaneConversationSummary {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  completedTurnCount: number | null;
  turnHistoryCoverage: 'complete' | 'partial';
}

export interface PaneLineageSummary {
  parentNodeId: string | null;
  parentRunId: string | null;
  originMessageId: string | null;
  treeRootNodeId: string | null;
  childNodeIds: string[];
  childrenTruncated: boolean;
}

export interface PaneRuntimeSummary {
  runtimeId: string | null;
  modelId: string | null;
  providerId: string | null;
  contextUsagePercentage: number | null;
}

export interface PaneDescriptorV1 {
  version: 1;
  ref: PaneRef;
  target: PaneTarget;
  kind: PaneKind;
  title: string;
  workspaceId: string;
  treeId: string | null;
  archived: boolean;
  /** Dotted field paths truncated due to response size limits, e.g. "presence.views".
   *  Identity, execution refs, status and cursor are never truncated. */
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
    views: PaneViewV1[];
  };
  conversation: Section<PaneConversationSummary>;
  lineage: Section<PaneLineageSummary>;
  runtime: Section<PaneRuntimeSummary>;
  latestOutput: Section<OutputPreview | null>;
}

// ---------------------------------------------------------------------------
// §11 Error codes
// ---------------------------------------------------------------------------

export type PaneInspectionErrorCode =
  | 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NAVIGATION_DISABLED'
  | 'UNSUPPORTED' | 'OUTPUT_CHANGED' | 'OUTPUT_UNAVAILABLE'
  | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED';

export const PANE_INSPECTION_ERROR_CODES: readonly PaneInspectionErrorCode[] = [
  'INVALID_ARGUMENT', 'NOT_FOUND', 'NAVIGATION_DISABLED',
  'UNSUPPORTED', 'OUTPUT_CHANGED', 'OUTPUT_UNAVAILABLE',
  'SOURCE_UNAVAILABLE', 'RATE_LIMITED',
];

/** One error shape shared by the service, HTTP routes and agent tools — raise this, not a bare Error. */
export class PaneInspectionError extends Error {
  constructor(readonly code: PaneInspectionErrorCode, readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PaneInspectionError';
  }
}

function fail(code: PaneInspectionErrorCode, path: string, message: string): never {
  throw new PaneInspectionError(code, path, message);
}

// ---------------------------------------------------------------------------
// §11 Limits — later tasks must not hardcode these numbers again
// ---------------------------------------------------------------------------

export const PANE_INSPECTION_LIMITS = {
  /** §6.4 latestOutput preview cap, UTF-8 bytes, truncated on a full code point. */
  outputPreviewBytes: 1_024,
  /** §7.3 read_pane_output default page size, bytes. */
  readOutputDefaultBytes: 16_384,
  /** §7.3 read_pane_output maximum page size, bytes. */
  readOutputMaxBytes: 65_536,
  /** §7.1 list_panes default page size. */
  listLimitDefault: 20,
  /** §7.1 list_panes maximum page size. */
  listLimitMax: 100,
  /** §6.3 lineage.childNodeIds default/max before childrenTruncated. */
  childrenDefaultMax: 100,
  /** §8 subscribePanes maximum distinct paneIds per stream. */
  subscribeMaxPanes: 32,
  /** §11 maximum concurrent wait_pane calls per owner. */
  concurrentWaitsPerOwnerMax: 8,
  /** §7.4 wait_pane default timeout, ms. */
  waitTimeoutDefaultMs: 20_000,
  /** §7.4 wait_pane maximum timeout, ms. */
  waitTimeoutMaxMs: 30_000,
  /** §11 maximum serialized PaneDescriptorV1 size, bytes. */
  descriptorMaxBytes: 32_768,
  /** §8 output_changed event coalescing window, ms; terminal events flush immediately. */
  outputChangedCoalesceMs: 250,
  /** §8 per-object inspection ring retention window, seconds. */
  ringRetentionSeconds: 60,
  /** §8 per-object inspection ring maximum event count. */
  ringMaxEvents: 256,
  /** §8 per-object inspection ring maximum size, bytes. */
  ringMaxBytes: 262_144,
  /** §8 per-workspace inspection ring budget, bytes, with LRU eviction beyond it. */
  workspaceRingBudgetBytes: 4 * 1024 * 1024,
  /** §9 presence keepalive interval, seconds. */
  presenceKeepaliveSeconds: 20,
  /** §9 presence lease TTL, seconds. */
  presenceTtlSeconds: 60,
  /** §6.1 cancel-requested to authoritative-terminal timeout before flagging CANCEL_TIMEOUT, ms. */
  cancelTimeoutMs: 15_000,
} as const;

// ---------------------------------------------------------------------------
// §4.1.1 ID codec
// ---------------------------------------------------------------------------

/**
 * Encodes a PaneTarget into the opaque, prefixed public paneId.
 *
 * Agent Run object identity uses `run:{runId}`. Backend routing remains a separate concern:
 * `PaneRef.backendConnectionId` and the selected gateway identify the backend, while this codec
 * round-trips only the `PaneTarget` fields it receives. Keeping those concerns separate preserves
 * `decodePaneId(encodePaneId(target)) === target` without duplicating connection state in the id.
 *
 * All runId values are percent-encoded (encodeURIComponent) so a literal `:` inside a runId
 * cannot be confused with the prefix separator — the same choice the existing frontend
 * `agentRunPaneId(backendConnectionId, runId)` helper (frontend/src/state/paneItems.ts) makes for
 * its own `pane:agent-run:<enc>:<enc>` id, which encodes the connection id separately from this
 * codec's paneId and is not itself decodable by this module (see module-level note below).
 * `node:` and `surface:` ids are single-segment and are not encoded, matching how
 * nodeId/registrationId are used verbatim elsewhere in this codebase.
 */
export function encodePaneId(target: PaneTarget): string {
  if (target.kind === 'node') return `node:${target.nodeId}`;
  if (target.kind === 'agent_run') return `run:${encodeURIComponent(target.runId)}`;
  return `surface:${target.registrationId}`;
}

/**
 * Decodes a paneId back into a PaneTarget. Inverse of encodePaneId; backend connection routing
 * stays in PaneRef/gateway context rather than inside the `run:{runId}` object identity.
 */
export function decodePaneId(paneId: string): PaneTarget {
  if (typeof paneId !== 'string') fail('INVALID_ARGUMENT', 'paneId', 'must be a string');
  if (paneId.trim() !== paneId) fail('INVALID_ARGUMENT', 'paneId', 'must not have leading or trailing whitespace');
  if (!paneId) fail('INVALID_ARGUMENT', 'paneId', 'must not be empty');

  const sepIndex = paneId.indexOf(':');
  if (sepIndex < 0) fail('INVALID_ARGUMENT', 'paneId', 'must have a recognized prefix');
  const prefix = paneId.slice(0, sepIndex + 1);
  const rest = paneId.slice(sepIndex + 1);

  if (prefix === 'node:') {
    if (!rest) fail('INVALID_ARGUMENT', 'paneId', 'node: id segment must not be empty');
    if (rest.includes(':')) fail('INVALID_ARGUMENT', 'paneId', 'node: must have exactly one segment');
    return { kind: 'node', nodeId: rest };
  }

  if (prefix === 'run:') {
    if (!rest) fail('INVALID_ARGUMENT', 'paneId', 'run: id segment must not be empty');
    if (rest.includes(':')) fail('INVALID_ARGUMENT', 'paneId', 'run: must have exactly one segment');
    let runId: string;
    try {
      runId = decodeURIComponent(rest);
    } catch {
      fail('INVALID_ARGUMENT', 'paneId', 'run: id segment is not valid percent-encoding');
    }
    if (!runId) fail('INVALID_ARGUMENT', 'paneId', 'run: id segment must not decode to empty');
    return { kind: 'agent_run', runId };
  }

  if (prefix === 'surface:') {
    if (!rest) fail('INVALID_ARGUMENT', 'paneId', 'surface: id segment must not be empty');
    if (rest.includes(':')) fail('INVALID_ARGUMENT', 'paneId', 'surface: must have exactly one segment');
    return { kind: 'surface', registrationId: rest };
  }

  fail('INVALID_ARGUMENT', 'paneId', `unknown prefix "${prefix}"`);
}

// ---------------------------------------------------------------------------
// §7 API parameter types
// ---------------------------------------------------------------------------

export type PaneListScope = 'open' | 'all';
export type ExecutionSelection = 'latest' | 'last_completed' | 'execution';
export type WaitUntil = 'changed' | 'terminal';
export type WaitReason = 'changed' | 'terminal' | 'timed_out' | 'unavailable';

export const WAIT_REASONS: readonly WaitReason[] = ['changed', 'terminal', 'timed_out', 'unavailable'];

/** Exactly one of paneId | nodeId | runId identifies the target object (design §7.2/§7.3/§7.4). */
export type PaneLocator =
  | { paneId: string }
  | { nodeId: string }
  | { runId: string };

export interface ListPanesRequestV1 {
  version: 1;
  workspaceId: string;
  treeId?: string;
  kind?: PaneKind;
  parentNodeId?: string;
  scope: PaneListScope;
  includeArchived: boolean;
  limit: number;
  cursor?: string | null;
}

export interface InspectPaneRequestV1 {
  version: 1;
  locator: PaneLocator;
  executionRef?: ExecutionRef;
}

export interface ReadPaneOutputRequestV1 {
  version: 1;
  locator: PaneLocator;
  selection: ExecutionSelection;
  executionRef?: ExecutionRef;
  outputId?: string;
  pageCursor?: string;
  limitBytes: number;
}

export interface SubscribePanesRequestV1 {
  version: 1;
  paneIds: string[];
  /** Most recently received observation cursor per paneId, if any. */
  cursors: Record<string, string | undefined>;
}

export interface WaitPaneRequestV1 {
  version: 1;
  locator: PaneLocator;
  until: WaitUntil;
  /** Required and only meaningful for until: 'changed'. */
  cursor?: string;
  /** Required and only meaningful for until: 'terminal'. */
  executionRef?: ExecutionRef;
  timeoutMs: number;
}

/** Compact summary type returned by list_panes — explicitly NO output body. */
export interface PaneSummaryV1 {
  ref: PaneRef;
  kind: PaneKind;
  title: string;
  activity: PaneActivity;
  latestExecution: { ref: ExecutionRef; outcome: ExecutionStatus | null } | null;
  openedInViews: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// §8 Feed event union
// ---------------------------------------------------------------------------

export type PaneFeedEventType =
  | 'snapshot' | 'changed' | 'output_changed' | 'execution_settled'
  | 'removed' | 'access_revoked' | 'resync_required' | 'heartbeat';

interface PaneFeedEventBase {
  version: 1;
  paneId: string;
  /** Opaque server-side lookup key — not decodable or forgeable by the client. */
  cursor: string;
  emittedAt: number;
}

export type PaneFeedEventV1 =
  | (PaneFeedEventBase & { type: 'snapshot'; descriptor: PaneDescriptorV1 })
  | (PaneFeedEventBase & { type: 'changed'; changedSections: string[]; descriptor: PaneDescriptorV1 })
  | (PaneFeedEventBase & { type: 'output_changed'; outputId: string; outputRevision: string; preview: OutputPreview })
  | (PaneFeedEventBase & { type: 'execution_settled'; execution: ExecutionRef; outcome: ExecutionStatus; commitState: CommitState; descriptor?: PaneDescriptorV1 })
  | (PaneFeedEventBase & { type: 'removed' })
  | (PaneFeedEventBase & { type: 'access_revoked' })
  | (PaneFeedEventBase & { type: 'resync_required' })
  | (PaneFeedEventBase & { type: 'heartbeat' });

export interface WaitPaneResultV1 {
  version: 1;
  reason: WaitReason;
  descriptor: PaneDescriptorV1 | null;
  outcome: ExecutionStatus | null;
  cursor: string;
}

// ---------------------------------------------------------------------------
// Parsers for untrusted input (renderer, model, HTTP query string) — §2/§3 of the P1-1 brief.
// Style mirrors shared/src/agentRuns.ts (parseAgentRunDtoV1 and its fail(...) helper), adapted to
// carry a PaneInspectionErrorCode instead of a single contract-error type.
// ---------------------------------------------------------------------------

function obj(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', path, 'must be an object');
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string, max = 4_096, empty = false): string {
  if (typeof value !== 'string') fail('INVALID_ARGUMENT', path, 'must be a string');
  const out = empty ? value : value.trim();
  if (!empty && !out) fail('INVALID_ARGUMENT', path, 'must not be empty');
  if (out.length > max) fail('INVALID_ARGUMENT', path, `must be at most ${max} characters`);
  return out;
}

function choice<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail('INVALID_ARGUMENT', path, `must be one of: ${values.join(', ')}`);
  return value as T;
}

function clampInt(value: unknown, path: string, fallback: number, max: number, min = 0): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    fail('INVALID_ARGUMENT', path, 'must be an integer');
  }
  if ((n as number) < min) fail('INVALID_ARGUMENT', path, `must be at least ${min}`);
  return Math.min(n as number, max);
}

/** Rejects non-integers outright (does not clamp them away) but clamps an in-range integer that
 *  exceeds max down to max, per the P1-1 brief's "clamp ... rather than trusting the caller, and
 *  reject non-integers". */
export function parseClampedInt(value: unknown, path: string, fallback: number, max: number, min = 0): number {
  return clampInt(value, path, fallback, max, min);
}

/** Exactly one of paneId | nodeId | runId must be present; two or zero is INVALID_ARGUMENT. */
export function parsePaneLocator(value: unknown, path = 'locator'): PaneLocator {
  const raw = obj(value, path);
  const provided = (['paneId', 'nodeId', 'runId'] as const).filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (provided.length !== 1) fail('INVALID_ARGUMENT', path, 'requires exactly one of paneId, nodeId, or runId');
  const key = provided[0];
  return { [key]: str(raw[key], `${path}.${key}`) } as PaneLocator;
}

export function parseExecutionRef(value: unknown, path = 'executionRef'): ExecutionRef {
  const raw = obj(value, path);
  const kind = choice(raw.kind, ['chat_turn', 'agent_run'] as const, `${path}.kind`);
  if (kind === 'chat_turn') {
    return { kind, nodeId: str(raw.nodeId, `${path}.nodeId`), turnId: str(raw.turnId, `${path}.turnId`) };
  }
  return { kind, runId: str(raw.runId, `${path}.runId`) };
}

export function parsePaneListScope(value: unknown, path = 'scope'): PaneListScope {
  return choice(value, ['open', 'all'] as const, path);
}

export function parseExecutionSelection(value: unknown, path = 'selection'): ExecutionSelection {
  return choice(value, ['latest', 'last_completed', 'execution'] as const, path);
}

export function parseWaitUntil(value: unknown, path = 'until'): WaitUntil {
  return choice(value, ['changed', 'terminal'] as const, path);
}

export function parsePaneKind(value: unknown, path = 'kind'): PaneKind {
  return choice(value, PANE_KINDS, path);
}

export function parseListLimit(value: unknown, path = 'limit'): number {
  return clampInt(value, path, PANE_INSPECTION_LIMITS.listLimitDefault, PANE_INSPECTION_LIMITS.listLimitMax, 1);
}

export function parseReadOutputLimitBytes(value: unknown, path = 'limitBytes'): number {
  return clampInt(value, path, PANE_INSPECTION_LIMITS.readOutputDefaultBytes, PANE_INSPECTION_LIMITS.readOutputMaxBytes, 1);
}

export function parseWaitTimeoutMs(value: unknown, path = 'timeoutMs'): number {
  return clampInt(value, path, PANE_INSPECTION_LIMITS.waitTimeoutDefaultMs, PANE_INSPECTION_LIMITS.waitTimeoutMaxMs, 1);
}

export function parseListPanesRequestV1(value: unknown, path = 'request'): ListPanesRequestV1 {
  const raw = obj(value, path);
  const out: ListPanesRequestV1 = {
    version: 1,
    workspaceId: str(raw.workspaceId, `${path}.workspaceId`),
    scope: raw.scope === undefined ? 'open' : parsePaneListScope(raw.scope, `${path}.scope`),
    includeArchived: raw.includeArchived === undefined ? false : Boolean(raw.includeArchived),
    limit: parseListLimit(raw.limit, `${path}.limit`),
  };
  if (raw.treeId !== undefined) out.treeId = str(raw.treeId, `${path}.treeId`);
  if (raw.kind !== undefined) out.kind = parsePaneKind(raw.kind, `${path}.kind`);
  if (raw.parentNodeId !== undefined) out.parentNodeId = str(raw.parentNodeId, `${path}.parentNodeId`);
  if (raw.cursor !== undefined) out.cursor = raw.cursor === null ? null : str(raw.cursor, `${path}.cursor`);
  return out;
}

export function parseInspectPaneRequestV1(value: unknown, path = 'request'): InspectPaneRequestV1 {
  const raw = obj(value, path);
  const out: InspectPaneRequestV1 = { version: 1, locator: parsePaneLocator(raw, path) };
  if (raw.executionRef !== undefined) out.executionRef = parseExecutionRef(raw.executionRef, `${path}.executionRef`);
  return out;
}

export function parseReadPaneOutputRequestV1(value: unknown, path = 'request'): ReadPaneOutputRequestV1 {
  const raw = obj(value, path);
  const selection = parseExecutionSelection(raw.selection, `${path}.selection`);
  if (selection === 'execution' && raw.executionRef === undefined) {
    fail('INVALID_ARGUMENT', `${path}.executionRef`, 'is required when selection is "execution"');
  }
  const out: ReadPaneOutputRequestV1 = {
    version: 1,
    locator: parsePaneLocator(raw, path),
    selection,
    limitBytes: parseReadOutputLimitBytes(raw.limitBytes, `${path}.limitBytes`),
  };
  if (raw.executionRef !== undefined) out.executionRef = parseExecutionRef(raw.executionRef, `${path}.executionRef`);
  if (raw.outputId !== undefined) out.outputId = str(raw.outputId, `${path}.outputId`);
  if (raw.pageCursor !== undefined) out.pageCursor = str(raw.pageCursor, `${path}.pageCursor`);
  return out;
}

export function parseSubscribePanesRequestV1(value: unknown, path = 'request'): SubscribePanesRequestV1 {
  const raw = obj(value, path);
  if (!Array.isArray(raw.paneIds)) fail('INVALID_ARGUMENT', `${path}.paneIds`, 'must be an array');
  if (raw.paneIds.length === 0) fail('INVALID_ARGUMENT', `${path}.paneIds`, 'must not be empty');
  if (raw.paneIds.length > PANE_INSPECTION_LIMITS.subscribeMaxPanes) {
    fail('INVALID_ARGUMENT', `${path}.paneIds`, `must contain at most ${PANE_INSPECTION_LIMITS.subscribeMaxPanes} items`);
  }
  const paneIds = raw.paneIds.map((id, i) => str(id, `${path}.paneIds[${i}]`));
  if (new Set(paneIds).size !== paneIds.length) fail('INVALID_ARGUMENT', `${path}.paneIds`, 'must not contain duplicates');
  const cursorsRaw = raw.cursors === undefined ? {} : obj(raw.cursors, `${path}.cursors`);
  const cursors: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(cursorsRaw)) {
    if (val !== undefined) cursors[key] = str(val, `${path}.cursors.${key}`);
  }
  return { version: 1, paneIds, cursors };
}

export function parseWaitPaneRequestV1(value: unknown, path = 'request'): WaitPaneRequestV1 {
  const raw = obj(value, path);
  const until = parseWaitUntil(raw.until, `${path}.until`);
  if (until === 'changed' && raw.cursor === undefined) {
    fail('INVALID_ARGUMENT', `${path}.cursor`, 'is required when until is "changed"');
  }
  if (until === 'terminal' && raw.executionRef === undefined) {
    fail('INVALID_ARGUMENT', `${path}.executionRef`, 'is required when until is "terminal"');
  }
  const out: WaitPaneRequestV1 = {
    version: 1,
    locator: parsePaneLocator(raw, path),
    until,
    timeoutMs: parseWaitTimeoutMs(raw.timeoutMs, `${path}.timeoutMs`),
  };
  if (raw.cursor !== undefined) out.cursor = str(raw.cursor, `${path}.cursor`);
  if (raw.executionRef !== undefined) out.executionRef = parseExecutionRef(raw.executionRef, `${path}.executionRef`);
  return out;
}
