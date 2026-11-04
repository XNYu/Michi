import {
  isMemoryKind,
  isMemoryMode,
  isMemoryOrigin,
  isMemoryStatus,
  type MemoryChangedEvent,
  type MemoryCreateRequest,
  type MemoryExtractionState,
  type MemoryListResponse,
  type MemoryMode,
  type MemoryRecord,
  type MemorySettings,
  type MemoryStatus,
  type MemoryUpdateRequest,
} from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import { readSseStream, SseHttpError } from './sseParser';
import { fetchStream } from './streamTransport';

// Michi Memory on this machine's backend (backend/src/routes/memories.ts):
// the records, the mode, the change feed, and automatic memory's status
// (routes/memoryExtraction.ts). A backend without a route answers 404;
// callers show that as unavailable rather than as a failure.

export class MemoryApiError extends Error {
  readonly status: number;
  /** version_conflict, invalid_state, memory_disabled, not_found, … when the backend named one. */
  readonly code: string | null;
  /** The stored version, with version_conflict. */
  readonly currentVersion: number | null;
  /** This backend has no such route: a 404 without a memory error code, or an answer of the wrong shape. */
  readonly unavailable: boolean;
  constructor(status: number, message: string, options: { code?: string | null; currentVersion?: number | null; unavailable?: boolean } = {}) {
    super(message);
    this.name = 'MemoryApiError';
    this.status = status;
    this.code = options.code ?? null;
    this.currentVersion = options.currentVersion ?? null;
    this.unavailable = options.unavailable ?? (status === 404 && !options.code);
  }
}

export function isMemoryVersionConflict(error: unknown): error is MemoryApiError {
  return error instanceof MemoryApiError && error.status === 409 && error.code === 'version_conflict';
}

export function isMemoryUnavailable(error: unknown): boolean {
  return error instanceof MemoryApiError && error.unavailable;
}

/** The memory is gone (deleted elsewhere, or never this owner's). */
export function isMemoryNotFound(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 404 && error.code === 'not_found';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown) => value === undefined || typeof value === 'string';

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isObject(value)) return false;
  const scope = value.scope;
  const scopeOk = isObject(scope) && (scope.kind === 'user' || (scope.kind === 'workspace' && typeof scope.workspaceId === 'string'));
  const source = value.source;
  const sourceOk = source === null || (isObject(source)
    && optionalString(source.nodeId) && optionalString(source.messageId) && optionalString(source.turnId) && optionalString(source.artifactId));
  return typeof value.id === 'string' && typeof value.body === 'string' && scopeOk && sourceOk
    && isMemoryKind(value.kind) && isMemoryStatus(value.status) && isMemoryOrigin(value.origin)
    && typeof value.version === 'number' && (value.sourceRisk === null || value.sourceRisk === 'untrusted')
    && (value.supersedesId === null || typeof value.supersedesId === 'string')
    && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number';
}

function isMemoryChangedEvent(value: unknown): value is MemoryChangedEvent {
  return isObject(value) && typeof value.memoryId === 'string' && typeof value.action === 'string'
    && isMemoryStatus(value.status) && typeof value.body === 'string' && isMemoryOrigin(value.origin)
    && (value.workspaceId === null || typeof value.workspaceId === 'string')
    && optionalString(value.nodeId) && (value.supersedesId === undefined || value.supersedesId === null || typeof value.supersedesId === 'string');
}

async function request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isObject(body) && typeof body.code === 'string' ? body.code : null;
    const message = isObject(body) && typeof body.error === 'string' ? body.error : `Memory request failed (${response.status})`;
    const currentVersion = isObject(body) && typeof body.currentVersion === 'number' ? body.currentVersion : null;
    throw new MemoryApiError(response.status, message, { code, currentVersion });
  }
  return body;
}

function unexpected(status = 200): MemoryApiError {
  return new MemoryApiError(status, 'Unexpected memory response', { unavailable: true });
}

function recordOf(body: unknown): MemoryRecord {
  const memory = isObject(body) ? body.memory : undefined;
  if (!isMemoryRecord(memory)) throw unexpected();
  return memory;
}

export interface MemoryListQuery {
  /** user: the global (user) scope only; workspace: workspace scopes; absent: both. */
  scope?: 'user' | 'workspace';
  workspaceId?: string;
  /** Default on the backend: active and pending. */
  status?: readonly MemoryStatus[];
  q?: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

/** Newest first. */
export async function listMemories(query: MemoryListQuery = {}): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  if (query.scope) params.set('scope', query.scope);
  if (query.workspaceId) params.set('workspaceId', query.workspaceId);
  if (query.status?.length) params.set('status', query.status.join(','));
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  const body = await request(`/memories${search ? `?${search}` : ''}`, { signal: query.signal });
  if (!isObject(body) || !Array.isArray(body.items) || !(body.nextCursor === null || typeof body.nextCursor === 'string')) throw unexpected();
  return { items: body.items.filter(isMemoryRecord), nextCursor: body.nextCursor };
}

/** Added by hand: explicit and active. */
export async function createMemory(input: MemoryCreateRequest): Promise<MemoryRecord> {
  return recordOf(await request('/memories', { method: 'POST', body: input }));
}

/** Rejects with a version_conflict MemoryApiError when the memory changed since `expectedVersion`. */
export async function updateMemory(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord> {
  return recordOf(await request(`/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }));
}

export async function deleteMemory(id: string): Promise<void> {
  await request(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function approveMemory(id: string): Promise<MemoryRecord> {
  return recordOf(await request(`/memories/${encodeURIComponent(id)}/approve`, { method: 'POST' }));
}

export async function rejectMemory(id: string): Promise<void> {
  await request(`/memories/${encodeURIComponent(id)}/reject`, { method: 'POST' });
}

function settingsOf(body: unknown): MemorySettings {
  if (!isObject(body) || !isMemoryMode(body.mode)) throw unexpected();
  return { mode: body.mode };
}

export async function fetchMemorySettings(signal?: AbortSignal): Promise<MemorySettings> {
  return settingsOf(await request('/memory-settings', { signal }));
}

export async function saveMemorySettings(mode: MemoryMode): Promise<MemorySettings> {
  return settingsOf(await request('/memory-settings', { method: 'PUT', body: { mode } }));
}

// ── automatic memory (C5) ──────────────────────────────────────────────────

/** The C5 status fields Settings › Memory shows; `state` is absent from backends older than the full status. */
export interface MemoryExtractionStatus {
  enabled: boolean;
  paused: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  pendingCount: number;
  todayTokens: number;
  dailyTokenLimit: number | null;
  state?: MemoryExtractionState;
  stateReason?: string | null;
  supported?: boolean;
}

const EXTRACTION_STATES: readonly MemoryExtractionState[] = [
  'off', 'unsupported', 'paused', 'maintenance_paused', 'stopped', 'budget_exhausted', 'running', 'waiting', 'idle',
];

const nullableNumber = (value: unknown) => value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));

function extractionStatusOf(body: unknown): MemoryExtractionStatus | null {
  if (!isObject(body) || typeof body.enabled !== 'boolean' || typeof body.paused !== 'boolean'
    || !nullableNumber(body.lastRunAt) || !(body.lastError === null || body.lastError === undefined || typeof body.lastError === 'string')
    || !nullableNumber(body.pendingCount) || !nullableNumber(body.todayTokens) || !nullableNumber(body.dailyTokenLimit)) return null;
  return {
    enabled: body.enabled,
    paused: body.paused,
    lastRunAt: (body.lastRunAt as number | null | undefined) ?? null,
    lastError: (body.lastError as string | null | undefined) || null,
    pendingCount: (body.pendingCount as number | null | undefined) ?? 0,
    todayTokens: (body.todayTokens as number | null | undefined) ?? 0,
    dailyTokenLimit: (body.dailyTokenLimit as number | null | undefined) ?? null,
    ...(EXTRACTION_STATES.includes(body.state as MemoryExtractionState) ? { state: body.state as MemoryExtractionState } : {}),
    ...(typeof body.stateReason === 'string' && body.stateReason ? { stateReason: body.stateReason } : {}),
    ...(typeof body.supported === 'boolean' ? { supported: body.supported } : {}),
  };
}

/** Null when this backend has no automatic memory yet (404, or an answer of another shape). */
export async function fetchMemoryExtractionStatus(signal?: AbortSignal): Promise<MemoryExtractionStatus | null> {
  try {
    return extractionStatusOf(await request('/memory-extraction/status', { signal }));
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
}

/** Pauses or resumes automatic memory; answers the status afterwards (null when unavailable). */
export async function setMemoryExtractionPaused(paused: boolean): Promise<MemoryExtractionStatus | null> {
  const body = await request(`/memory-extraction/${paused ? 'pause' : 'resume'}`, { method: 'POST', body: {} });
  return extractionStatusOf(body) ?? fetchMemoryExtractionStatus();
}

// ── change feed (C4) ───────────────────────────────────────────────────────

export interface MemoryChangeSubscription {
  onEvent: (event: MemoryChangedEvent) => void;
  onOpen?: () => void;
  /** The feed ended or failed; an SseHttpError carries the HTTP status. Not called after unsubscribe. */
  onDisconnect?: (error?: Error) => void;
}

/**
 * GET /api/memories/changes/stream through the shared stream transport:
 * every later change to the caller's memories, whoever made it. Returns
 * unsubscribe.
 */
export function subscribeMemoryChanges(options: MemoryChangeSubscription): () => void {
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    let disconnectError: Error | undefined;
    try {
      const response = await fetchStream(`${API_BASE_URL}/memories/changes/stream`, { signal: controller.signal });
      if (!response.ok) throw new SseHttpError(response.status, 'subscribeMemoryChanges failed');
      if (!response.body) throw new Error('subscribeMemoryChanges response has no body');
      if (stopped) return;
      options.onOpen?.();
      await readSseStream(response.body.getReader(), (event, data) => {
        if (event !== 'memory_changed') return;
        let json: unknown;
        try { json = JSON.parse(data); } catch { return; }
        if (isMemoryChangedEvent(json)) options.onEvent({ ...json, supersedesId: json.supersedesId ?? null });
      }, { shouldStop: () => stopped });
    } catch (error) {
      if (!stopped) disconnectError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!stopped) options.onDisconnect?.(disconnectError);
    }
  })();
  return () => { stopped = true; controller.abort(); };
}
