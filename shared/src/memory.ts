/**
 * Michi Memory: durable, owner-scoped notes (preferences, facts, decisions,
 * conventions) that every runtime can read and correct. The backend owns
 * storage and access checks (services/memory); these are the shapes its
 * service, REST API and change events share with the renderer.
 */

export const MEMORY_KINDS = ['preference', 'fact', 'decision', 'convention'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

/**
 * active: visible to search and injection. pending: awaiting the user's
 * approval (an untrusted turn or automatic extraction wrote it).
 * superseded: replaced by a correction; kept for history, hidden by default.
 */
export const MEMORY_STATUSES = ['active', 'pending', 'superseded'] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

export const MEMORY_ORIGINS = ['explicit', 'extracted'] as const;
export type MemoryOrigin = typeof MEMORY_ORIGINS[number];

/** Set when the memory was written from a turn that read untrusted content. */
export type MemorySourceRisk = 'untrusted';

/** The whole user (every workspace), or one workspace the owner owns. */
export type MemoryScope = { kind: 'user' } | { kind: 'workspace'; workspaceId: string };

/** Where the memory came from; every field is optional and none grants access. */
export interface MemorySource {
  nodeId?: string;
  messageId?: string;
  turnId?: string;
  artifactId?: string;
}

export interface MemoryRecord {
  id: string;
  ownerUserId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
  source: MemorySource | null;
  status: MemoryStatus;
  origin: MemoryOrigin;
  /** Optimistic-lock version of this record; starts at 1, +1 on every change. */
  version: number;
  /** The record this one corrects; it becomes superseded once this one is active. */
  supersedesId: string | null;
  sourceRisk: MemorySourceRisk | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * off: memory is neither read nor written by agents (existing entries can
 * still be listed and deleted). explicit: saved only when asked. auto: also
 * proposed by background extraction.
 */
export const MEMORY_MODES = ['off', 'explicit', 'auto'] as const;
export type MemoryMode = typeof MEMORY_MODES[number];

export interface MemorySettings {
  mode: MemoryMode;
}

export const DEFAULT_MEMORY_SETTINGS: Readonly<MemorySettings> = Object.freeze({ mode: 'explicit' });

/** Longest memory body accepted, in UTF-16 code units, after trimming. */
export const MEMORY_BODY_MAX_CHARS = 2000;

export type MemoryChangeAction = 'created' | 'updated' | 'superseded' | 'deleted' | 'approved' | 'rejected';

/** One stored change; `status` is the record's status after the change (before it, for deleted/rejected). */
export interface MemoryChangedEvent {
  ownerUserId: string;
  workspaceId: string | null;
  memoryId: string;
  action: MemoryChangeAction;
  status: MemoryStatus;
  body: string;
  origin: MemoryOrigin;
  nodeId?: string;
  supersedesId: string | null;
}

// ── REST (/api/memories, /api/memory-settings) ─────────────────────────────

export interface MemoryListResponse {
  items: MemoryRecord[];
  nextCursor: string | null;
}

/** POST /api/memories: a memory the user adds by hand (origin explicit, status active). */
export interface MemoryCreateRequest {
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
}

/** PATCH /api/memories/:id */
export interface MemoryUpdateRequest {
  body?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  expectedVersion: number;
}

/** Response body for a single record (create, update, approve). */
export interface MemoryResponse {
  memory: MemoryRecord;
}

export type MemoryErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'version_conflict'
  | 'invalid_state'
  | 'memory_disabled';

/** Error body; `currentVersion` accompanies version_conflict. */
export interface MemoryErrorResponse {
  error: string;
  code: MemoryErrorCode | 'unauthorized';
  currentVersion?: number;
}

// ── Automatic memory extraction (C5: /api/memory-extraction) ───────────────

/** The extractor's guess: this workspace only, or perhaps every workspace (the user decides). */
export type MemoryExtractionScopeHint = 'workspace' | 'maybe_global';

/**
 * What automatic extraction is doing now, most blocking first:
 * off (memory mode is not auto), unsupported (this backend or the Meta agent
 * runtime cannot run it; see stateReason), paused (POST pause),
 * maintenance_paused (the Meta agent's global maintenance pause), stopped
 * (a workspace's runs stopped after repeated failures; resume restarts them),
 * budget_exhausted (the daily token limit is reached), running, waiting
 * (new turns not yet processed) and idle (up to date).
 */
export type MemoryExtractionState =
  | 'off' | 'unsupported' | 'paused' | 'maintenance_paused' | 'stopped' | 'budget_exhausted' | 'running' | 'waiting' | 'idle';

export interface MemoryExtractionRunSummary {
  id: string;
  workspaceId: string;
  state: 'active' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  sources: number;
  proposed: number;
  noChange: number;
  dropped: number;
  /** Reported by the runtime, else Michi's estimate; null while running. */
  tokens: number | null;
}

/** GET /api/memory-extraction/status, and the answer of pause/resume/cancel. */
export interface MemoryExtractionStatus {
  /** Memory mode is auto. */
  enabled: boolean;
  /** Paused for every workspace (POST /api/memory-extraction/pause without workspaceId). */
  paused: boolean;
  lastRunAt: number | null;
  /** The newest run's error when it did not succeed, or why runs are held. */
  lastError: string | null;
  /** Extracted memories waiting for approval. */
  pendingCount: number;
  todayTokens: number;
  dailyTokenLimit: number;
  executionTokenLimit: number;
  state: MemoryExtractionState;
  stateReason: string | null;
  /** False on backends that cannot run background extraction (cloud, no scheduler). */
  supported: boolean;
  pausedWorkspaceIds: string[];
  /** Pending extracted memories the extractor marked maybe_global. */
  maybeGlobalMemoryIds: string[];
  /** What extraction never proposes (EXTRACTION_EXCLUSIONS). */
  exclusions: string[];
  recentRuns: MemoryExtractionRunSummary[];
}

/** POST /api/memory-extraction/pause|resume: without workspaceId, every workspace. */
export interface MemoryExtractionPauseRequest {
  workspaceId?: string;
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value);
}

export function isMemoryOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === 'string' && (MEMORY_ORIGINS as readonly string[]).includes(value);
}

export function isMemoryMode(value: unknown): value is MemoryMode {
  return typeof value === 'string' && (MEMORY_MODES as readonly string[]).includes(value);
}
