import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_BODY_MAX_CHARS,
  isMemoryKind,
  isMemoryMode,
  isMemoryOrigin,
  isMemoryStatus,
  type MemoryChangeAction,
  type MemoryChangedEvent,
  type MemoryErrorCode,
  type MemoryKind,
  type MemoryMode,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryScope,
  type MemorySettings,
  type MemorySource,
  type MemorySourceRisk,
  type MemoryStatus,
} from 'michi-shared';
import { DomainError, type DomainErrorKind } from '../domainErrors';
import { log } from '../logger';
import {
  bumpScopeVersion,
  deleteMemoryRow,
  findMemory,
  insertMemoryRow,
  listMemoryRows,
  memoryTransaction,
  pinnedMemoryRows,
  readMemoryMode,
  readScopeVersion,
  searchMemoryRows,
  splitTerms,
  updateMemoryRow,
  workspaceAccessible,
  writeMemoryMode,
  type MemoryRowChanges,
  type MemoryScopeFilter,
} from './memoryRepository';

/**
 * Michi Memory service (C1). Every entry point takes the caller's owner and
 * nothing else that grants access: rows are read and written only for that
 * owner (memoryRepository), and a workspace scope must be a workspace the
 * owner owns. Changes bump a per-scope counter (memoryVersion) and are
 * announced on memoryEvents after they commit.
 */

export interface MemoryCaller {
  ownerUserId: string;
}

const KIND_FOR_CODE: Record<MemoryErrorCode, DomainErrorKind> = {
  invalid_argument: 'invalid_argument',
  not_found: 'not_found',
  version_conflict: 'conflict',
  invalid_state: 'conflict',
  memory_disabled: 'conflict',
};

/**
 * not_found also covers another owner's memory or workspace, so callers
 * cannot tell the two apart. memory_disabled: the owner's mode is off.
 */
export class MemoryError extends DomainError {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    /** The stored version, for version_conflict. */
    readonly currentVersion?: number,
  ) {
    super(KIND_FOR_CODE[code], code, message);
  }
}

// ── events and hooks ───────────────────────────────────────────────────────

export interface MemorySettingsChangedEvent {
  ownerUserId: string;
  mode: MemoryMode;
  previousMode: MemoryMode;
}

interface MemoryEventMap {
  /** One per stored record change (C4 payload). */
  changed: [MemoryChangedEvent];
  settingsChanged: [MemorySettingsChangedEvent];
}

/**
 * Emitted synchronously once the change's savepoint is released: committed,
 * unless the caller wrapped the call in a transaction of its own. A throwing
 * listener is logged, never the caller's failure.
 */
export const memoryEvents = new EventEmitter<MemoryEventMap>();

export interface MemoryRemoval {
  /** The record as it was stored just before removal. */
  record: MemoryRecord;
  reason: 'deleted' | 'rejected';
}

type MemoryRemovalHook = (removal: MemoryRemoval) => void;
const removalHooks = new Set<MemoryRemovalHook>();

/**
 * Run `hook` whenever deleteMemory or rejectMemory removes a record (for
 * example to write a tombstone so extraction never proposes it again). The
 * hook runs synchronously inside the removing transaction, after the row is
 * gone: its own writes to data.db commit with the removal, and a hook that
 * throws rolls the removal back. Returns an unregister function.
 */
export function onMemoryRemoved(hook: MemoryRemovalHook): () => void {
  removalHooks.add(hook);
  return () => { removalHooks.delete(hook); };
}

function emitChanged(record: MemoryRecord, action: MemoryChangeAction): void {
  const event: MemoryChangedEvent = {
    ownerUserId: record.ownerUserId,
    workspaceId: scopeWorkspaceId(record.scope),
    memoryId: record.id,
    action,
    status: record.status,
    body: record.body,
    origin: record.origin,
    ...(record.source?.nodeId ? { nodeId: record.source.nodeId } : {}),
    supersedesId: record.supersedesId,
  };
  try {
    memoryEvents.emit('changed', event);
  } catch (error) {
    log.warn('workspace', 'memory change listener failed', { action, error: (error as Error).message });
  }
}

// ── validation ─────────────────────────────────────────────────────────────

function owner(caller: MemoryCaller): string {
  const id = typeof caller?.ownerUserId === 'string' ? caller.ownerUserId.trim() : '';
  if (!id) throw new MemoryError('invalid_argument', 'ownerUserId is required');
  return id;
}

function memoryId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim()) throw new MemoryError('not_found', 'Memory not found');
  return id;
}

function normalizeBody(body: unknown): string {
  if (typeof body !== 'string') throw new MemoryError('invalid_argument', 'body must be a string');
  const trimmed = body.trim();
  if (!trimmed) throw new MemoryError('invalid_argument', 'body must not be empty');
  if (trimmed.length > MEMORY_BODY_MAX_CHARS) {
    throw new MemoryError('invalid_argument', `body must be at most ${MEMORY_BODY_MAX_CHARS} characters`);
  }
  return trimmed;
}

function normalizeKind(kind: unknown): MemoryKind {
  if (!isMemoryKind(kind)) throw new MemoryError('invalid_argument', 'kind must be preference, fact, decision or convention');
  return kind;
}

function normalizeOrigin(origin: unknown): MemoryOrigin {
  if (!isMemoryOrigin(origin)) throw new MemoryError('invalid_argument', 'origin must be explicit or extracted');
  return origin;
}

type NewMemoryStatus = Exclude<MemoryStatus, 'superseded'>;

function normalizeNewStatus(status: unknown): NewMemoryStatus {
  if (status !== 'active' && status !== 'pending') throw new MemoryError('invalid_argument', 'status must be active or pending');
  return status;
}

function normalizeSourceRisk(risk: unknown): MemorySourceRisk | null {
  if (risk === undefined || risk === null) return null;
  if (risk !== 'untrusted') throw new MemoryError('invalid_argument', 'sourceRisk must be untrusted or null');
  return risk;
}

const SOURCE_KEYS = ['nodeId', 'messageId', 'turnId', 'artifactId'] as const;
const SOURCE_ID_MAX_CHARS = 256;

function normalizeSource(source: unknown): MemorySource | null {
  if (source === undefined || source === null) return null;
  if (typeof source !== 'object' || Array.isArray(source)) throw new MemoryError('invalid_argument', 'source must be an object');
  const input = source as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((key) => !(SOURCE_KEYS as readonly string[]).includes(key));
  if (unknownKey) throw new MemoryError('invalid_argument', `source.${unknownKey} is not supported`);
  const result: MemorySource = {};
  for (const key of SOURCE_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > SOURCE_ID_MAX_CHARS) {
      throw new MemoryError('invalid_argument', `source.${key} must be a string of at most ${SOURCE_ID_MAX_CHARS} characters`);
    }
    if (value.trim()) result[key] = value.trim();
  }
  return Object.keys(result).length > 0 ? result : null;
}

function scopeWorkspaceId(scope: MemoryScope): string | null {
  return scope.kind === 'workspace' ? scope.workspaceId : null;
}

/** A workspace id the owner may use, or not_found (missing, permanently deleted or someone else's). */
function accessibleWorkspace(ownerUserId: string, workspaceId: unknown): string {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new MemoryError('invalid_argument', 'workspaceId must be a non-empty string');
  }
  if (!workspaceAccessible(ownerUserId, workspaceId)) throw new MemoryError('not_found', 'Workspace not found');
  return workspaceId;
}

/** The stored workspace id for a scope: null for the user scope. */
function resolveScope(ownerUserId: string, scope: unknown): string | null {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new MemoryError('invalid_argument', 'scope must be { kind: "user" } or { kind: "workspace", workspaceId }');
  }
  const value = scope as Record<string, unknown>;
  if (value.kind === 'user' && Object.keys(value).every((key) => key === 'kind')) return null;
  if (value.kind === 'workspace' && Object.keys(value).every((key) => key === 'kind' || key === 'workspaceId')) {
    return accessibleWorkspace(ownerUserId, value.workspaceId);
  }
  throw new MemoryError('invalid_argument', 'scope must be { kind: "user" } or { kind: "workspace", workspaceId }');
}

function normalizeStatuses(statuses: unknown, fallback: readonly MemoryStatus[]): readonly MemoryStatus[] {
  if (statuses === undefined || statuses === null) return fallback;
  if (!Array.isArray(statuses) || !statuses.every(isMemoryStatus)) {
    throw new MemoryError('invalid_argument', 'status must list active, pending or superseded');
  }
  return statuses.length > 0 ? [...new Set(statuses)] : fallback;
}

function normalizeLimit(limit: unknown, fallback: number, max: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new MemoryError('invalid_argument', 'limit must be a positive integer');
  }
  return Math.min(limit, max);
}

function optionalWorkspaceId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new MemoryError('invalid_argument', 'workspaceId must be a string');
  return value;
}

// ── mode ───────────────────────────────────────────────────────────────────

function memoryMode(ownerUserId: string): MemoryMode {
  return readMemoryMode(ownerUserId) ?? DEFAULT_MEMORY_SETTINGS.mode;
}

function assertEnabled(ownerUserId: string): void {
  if (memoryMode(ownerUserId) === 'off') throw new MemoryError('memory_disabled', 'Memory is turned off');
}

export function getMemorySettings(ownerUserId: string): MemorySettings {
  return { mode: memoryMode(owner({ ownerUserId })) };
}

/** A mode change also bumps the user scope's version, so injected memory refreshes. */
export function setMemorySettings(ownerUserId: string, settings: MemorySettings): void {
  const ownerId = owner({ ownerUserId });
  const mode = settings?.mode;
  if (!isMemoryMode(mode)) throw new MemoryError('invalid_argument', 'mode must be off, explicit or auto');
  const previousMode = memoryMode(ownerId);
  memoryTransaction(() => {
    const now = Date.now();
    writeMemoryMode(ownerId, mode, now);
    if (mode !== previousMode) bumpScopeVersion(ownerId, null, now);
  });
  if (mode === previousMode) return;
  try {
    memoryEvents.emit('settingsChanged', { ownerUserId: ownerId, mode, previousMode });
  } catch (error) {
    log.warn('workspace', 'memory settings listener failed', { error: (error as Error).message });
  }
}

// ── writes ─────────────────────────────────────────────────────────────────

export interface CreateMemoryInput {
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
  source?: MemorySource | null;
  status: NewMemoryStatus;
  origin: MemoryOrigin;
  /** The record this one corrects (see supersedeMemory). */
  supersedesId?: string | null;
  sourceRisk?: MemorySourceRisk | null;
}

function requireMemory(ownerUserId: string, id: unknown): MemoryRecord {
  const record = findMemory(ownerUserId, memoryId(id));
  if (!record) throw new MemoryError('not_found', 'Memory not found');
  return record;
}

function markSuperseded(ownerUserId: string, old: MemoryRecord, now: number): MemoryRecord | null {
  if (old.status === 'superseded') return null;
  const updated = updateMemoryRow(ownerUserId, old.id, old.version, { status: 'superseded' }, now);
  if (!updated) throw new MemoryError('version_conflict', 'The corrected memory changed; reload it and try again');
  bumpScopeVersion(ownerUserId, scopeWorkspaceId(old.scope), now);
  return updated;
}

/**
 * Store a memory. status pending waits for approveMemory. With supersedesId
 * the new record corrects that one (same owner; active or pending): an active
 * correction supersedes it now, a pending one on approval.
 */
export function createMemory(caller: MemoryCaller, input: CreateMemoryInput): MemoryRecord {
  const ownerUserId = owner(caller);
  if (!input || typeof input !== 'object') throw new MemoryError('invalid_argument', 'input is required');
  const body = normalizeBody(input.body);
  const kind = normalizeKind(input.kind);
  const status = normalizeNewStatus(input.status);
  const origin = normalizeOrigin(input.origin);
  const source = normalizeSource(input.source);
  const sourceRisk = normalizeSourceRisk(input.sourceRisk);
  assertEnabled(ownerUserId);
  const { created, superseded } = memoryTransaction(() => {
    const workspaceId = resolveScope(ownerUserId, input.scope);
    let old: MemoryRecord | null = null;
    if (input.supersedesId !== undefined && input.supersedesId !== null) {
      old = requireMemory(ownerUserId, input.supersedesId);
      if (old.status === 'superseded') {
        throw new MemoryError('invalid_state', 'That memory was already corrected; correct the newer one');
      }
    }
    const now = Date.now();
    const record = insertMemoryRow({
      id: `mem-${randomUUID()}`, ownerUserId, workspaceId, kind, body, status, origin, source, sourceRisk,
      supersedesId: old?.id ?? null, now,
    });
    bumpScopeVersion(ownerUserId, workspaceId, now);
    return { created: record, superseded: old && status === 'active' ? markSuperseded(ownerUserId, old, now) : null };
  });
  emitChanged(created, 'created');
  if (superseded) emitChanged(superseded, 'superseded');
  return created;
}

export interface SupersedeMemoryInput {
  body: string;
  /** Defaults to the corrected record's kind. */
  kind?: MemoryKind;
  source?: MemorySource | null;
  status: NewMemoryStatus;
  origin: MemoryOrigin;
  sourceRisk?: MemorySourceRisk | null;
}

/** Correct a memory: a new record in the old one's scope, linked by supersedesId. */
export function supersedeMemory(caller: MemoryCaller, oldId: string, input: SupersedeMemoryInput): MemoryRecord {
  const ownerUserId = owner(caller);
  const old = requireMemory(ownerUserId, oldId);
  return createMemory(caller, {
    scope: old.scope,
    kind: input?.kind ?? old.kind,
    body: input?.body,
    source: input?.source,
    status: input?.status,
    origin: input?.origin,
    sourceRisk: input?.sourceRisk,
    supersedesId: old.id,
  });
}

export interface MemoryPatch {
  body?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
}

/**
 * Edit body, scope or kind. With expectedVersion the edit applies only to
 * that version (version_conflict otherwise). Superseded records are history
 * and cannot be edited.
 */
export function updateMemory(caller: MemoryCaller, id: string, patch: MemoryPatch, expectedVersion?: number): MemoryRecord {
  const ownerUserId = owner(caller);
  if (!patch || typeof patch !== 'object') throw new MemoryError('invalid_argument', 'patch is required');
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new MemoryError('invalid_argument', 'expectedVersion must be a positive integer');
  }
  const changes: MemoryRowChanges = {};
  if (patch.body !== undefined) changes.body = normalizeBody(patch.body);
  if (patch.kind !== undefined) changes.kind = normalizeKind(patch.kind);
  const updated = memoryTransaction(() => {
    const current = requireMemory(ownerUserId, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new MemoryError('version_conflict', 'The memory changed since it was read', current.version);
    }
    if (current.status === 'superseded') throw new MemoryError('invalid_state', 'A superseded memory cannot be edited');
    const fromWorkspaceId = scopeWorkspaceId(current.scope);
    if (patch.scope !== undefined) {
      const toWorkspaceId = resolveScope(ownerUserId, patch.scope);
      if (toWorkspaceId !== fromWorkspaceId) changes.workspaceId = toWorkspaceId;
    }
    if (changes.body === current.body) delete changes.body;
    if (changes.kind === current.kind) delete changes.kind;
    if (Object.keys(changes).length === 0) return null;
    const now = Date.now();
    const record = updateMemoryRow(ownerUserId, current.id, current.version, changes, now);
    if (!record) throw new MemoryError('version_conflict', 'The memory changed since it was read');
    bumpScopeVersion(ownerUserId, fromWorkspaceId, now);
    if (changes.workspaceId !== undefined) bumpScopeVersion(ownerUserId, changes.workspaceId, now);
    return record;
  });
  if (!updated) return requireMemory(ownerUserId, id);
  emitChanged(updated, 'updated');
  return updated;
}

/** pending → active; the record it corrects, if still there, becomes superseded. */
export function approveMemory(caller: MemoryCaller, id: string): MemoryRecord {
  const ownerUserId = owner(caller);
  const { approved, superseded } = memoryTransaction(() => {
    const current = requireMemory(ownerUserId, id);
    if (current.status !== 'pending') throw new MemoryError('invalid_state', 'Only a pending memory can be approved');
    const now = Date.now();
    const record = updateMemoryRow(ownerUserId, current.id, current.version, { status: 'active' }, now);
    if (!record) throw new MemoryError('version_conflict', 'The memory changed since it was read');
    bumpScopeVersion(ownerUserId, scopeWorkspaceId(record.scope), now);
    const old = record.supersedesId ? findMemory(ownerUserId, record.supersedesId) : null;
    return { approved: record, superseded: old ? markSuperseded(ownerUserId, old, now) : null };
  });
  emitChanged(approved, 'approved');
  if (superseded) emitChanged(superseded, 'superseded');
  return approved;
}

function removeMemory(ownerUserId: string, id: string, reason: MemoryRemoval['reason']): void {
  const removed = memoryTransaction(() => {
    const current = requireMemory(ownerUserId, id);
    if (reason === 'rejected' && current.status !== 'pending') {
      throw new MemoryError('invalid_state', 'Only a pending memory can be rejected');
    }
    if (!deleteMemoryRow(ownerUserId, current.id)) throw new MemoryError('not_found', 'Memory not found');
    bumpScopeVersion(ownerUserId, scopeWorkspaceId(current.scope), Date.now());
    for (const hook of [...removalHooks]) hook({ record: current, reason });
    return current;
  });
  emitChanged(removed, reason);
}

/** Discard a pending memory (a hard delete, like deleteMemory). */
export function rejectMemory(caller: MemoryCaller, id: string): void {
  removeMemory(owner(caller), id, 'rejected');
}

/** Hard delete of the record and its search index entry; onMemoryRemoved hooks run in the same transaction. */
export function deleteMemory(caller: MemoryCaller, id: string): void {
  removeMemory(owner(caller), id, 'deleted');
}

// ── reads ──────────────────────────────────────────────────────────────────

/** One of the caller's memories, whatever its status; not_found for a missing or another owner's id. Works with mode off. */
export function getMemory(caller: MemoryCaller, id: string): MemoryRecord {
  return requireMemory(owner(caller), id);
}

export interface MemorySearchQuery {
  query: string;
  /** Also search this workspace (it must be the caller's). */
  workspaceId?: string | null;
  /** Search the user scope too; default true. */
  includeUser?: boolean;
  /** Default ['active']. */
  status?: MemoryStatus[];
  /** Default 10, at most 50. */
  limit?: number;
}

const SEARCH_DEFAULT_STATUSES: readonly MemoryStatus[] = ['active'];
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;

/**
 * Ranked recall over the user scope and, when given, one workspace. Terms are
 * whitespace-separated and any of them may match; terms of three or more
 * characters use the trigram FTS index, shorter ones LIKE. Without a
 * workspaceId only the user scope is searched.
 */
export function searchMemories(caller: MemoryCaller, q: MemorySearchQuery): MemoryRecord[] {
  const ownerUserId = owner(caller);
  if (!q || typeof q.query !== 'string') throw new MemoryError('invalid_argument', 'query must be a string');
  const terms = splitTerms(q.query);
  if (terms.all.length === 0) throw new MemoryError('invalid_argument', 'query must not be empty');
  const statuses = normalizeStatuses(q.status, SEARCH_DEFAULT_STATUSES);
  const limit = normalizeLimit(q.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
  const workspaceId = optionalWorkspaceId(q.workspaceId);
  assertEnabled(ownerUserId);
  const scope: MemoryScopeFilter = {
    user: q.includeUser !== false,
    workspaceIds: workspaceId === null ? [] : [accessibleWorkspace(ownerUserId, workspaceId)],
  };
  return searchMemoryRows(ownerUserId, { scope, statuses, terms, limit });
}

export interface MemoryListQuery {
  /** user: the user scope only. workspace: workspaceId's, or every workspace's. Absent: both. */
  scope?: 'user' | 'workspace';
  workspaceId?: string | null;
  /** Default ['active', 'pending']. */
  status?: MemoryStatus[];
  cursor?: string | null;
  /** Default 50, at most 200. */
  limit?: number;
  /** Keep records containing every whitespace-separated term. */
  query?: string;
}

const LIST_DEFAULT_STATUSES: readonly MemoryStatus[] = ['active', 'pending'];
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

function encodeCursor(rowId: number): string {
  return Buffer.from(`m:${rowId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const match = typeof cursor === 'string' ? /^m:([1-9]\d{0,15})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
  if (!match) throw new MemoryError('invalid_argument', 'cursor is invalid');
  return Number(match[1]);
}

/**
 * Newest first, for managing memories (works with mode off). With no scope
 * and no workspaceId: everything the caller owns.
 */
export function listMemories(caller: MemoryCaller, q: MemoryListQuery = {}): { items: MemoryRecord[]; nextCursor: string | null } {
  const ownerUserId = owner(caller);
  if (q.scope !== undefined && q.scope !== 'user' && q.scope !== 'workspace') {
    throw new MemoryError('invalid_argument', 'scope must be user or workspace');
  }
  const workspaceId = optionalWorkspaceId(q.workspaceId);
  if (q.scope === 'user' && workspaceId !== null) {
    throw new MemoryError('invalid_argument', 'workspaceId cannot be combined with scope user');
  }
  if (q.query !== undefined && typeof q.query !== 'string') throw new MemoryError('invalid_argument', 'query must be a string');
  const statuses = normalizeStatuses(q.status, LIST_DEFAULT_STATUSES);
  const limit = normalizeLimit(q.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const beforeRowId = decodeCursor(q.cursor);
  const workspaces = workspaceId === null ? 'all' as const : [accessibleWorkspace(ownerUserId, workspaceId)];
  const scope: MemoryScopeFilter = {
    user: q.scope !== 'workspace',
    workspaceIds: q.scope === 'user' ? [] : workspaces,
  };
  const terms = q.query ? splitTerms(q.query) : null;
  const page = listMemoryRows(ownerUserId, {
    scope, statuses, terms: terms && terms.all.length > 0 ? terms : null, beforeRowId, limit,
  });
  return { items: page.records, nextCursor: page.more && page.lastRowId !== null ? encodeCursor(page.lastRowId) : null };
}

/**
 * Active preferences and conventions to pin into a prompt: the user scope
 * first, then the workspace's, newest first in each. Greedy within
 * budgetChars (sum of body lengths): a body that does not fit is skipped and
 * smaller later ones may still be taken. Empty when the mode is off.
 */
export function pinnedPreferences(caller: MemoryCaller, workspaceId: string | null, budgetChars: number): MemoryRecord[] {
  const ownerUserId = owner(caller);
  if (!Number.isFinite(budgetChars) || budgetChars <= 0) return [];
  if (memoryMode(ownerUserId) === 'off') return [];
  const picked: MemoryRecord[] = [];
  let remaining = Math.floor(budgetChars);
  for (const record of pinnedMemoryRows(ownerUserId, optionalWorkspaceId(workspaceId))) {
    if (record.body.length > remaining) continue;
    picked.push(record);
    remaining -= record.body.length;
  }
  return picked;
}

/**
 * Grows whenever anything in the caller's user scope (including the memory
 * mode) or in this workspace's scope changes; compare for equality only.
 */
export function memoryVersion(caller: MemoryCaller, workspaceId: string | null): number {
  const ownerUserId = owner(caller);
  const ws = optionalWorkspaceId(workspaceId);
  return readScopeVersion(ownerUserId, null) + (ws === null ? 0 : readScopeVersion(ownerUserId, ws));
}
