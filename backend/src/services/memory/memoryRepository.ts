import type {
  MemoryKind,
  MemoryMode,
  MemoryOrigin,
  MemoryRecord,
  MemorySource,
  MemorySourceRisk,
  MemoryStatus,
} from 'michi-shared';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { purgeOwnerExtraction, purgeWorkspaceExtraction } from './extractionRepository';

/**
 * SQL for Michi Memory (migration 0059_memories). Every read and write takes
 * the caller's ownerUserId and filters on it here, so no parameter a caller
 * passes can reach another owner's rows. Workspace-scope rows additionally
 * require the workspace to belong to that owner when they are written.
 * Validation, versioning and events live in memoryService.ts.
 */

interface MemoryRow {
  row_id: number;
  id: string;
  owner_user_id: string;
  scope: 'user' | 'workspace';
  workspace_id: string | null;
  kind: MemoryKind;
  body: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  source_node_id: string | null;
  source_message_id: string | null;
  source_turn_id: string | null;
  source_artifact_id: string | null;
  source_risk: MemorySourceRisk | null;
  supersedes_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `m.row_id, m.id, m.owner_user_id, m.scope, m.workspace_id, m.kind, m.body, m.status, m.origin,
  m.source_node_id, m.source_message_id, m.source_turn_id, m.source_artifact_id, m.source_risk,
  m.supersedes_id, m.version, m.created_at, m.updated_at`;

/** user scope in memory_scope_versions; workspace ids are never empty. */
const USER_SCOPE_KEY = '';

function toRecord(row: MemoryRow): MemoryRecord {
  const source: MemorySource = {};
  if (row.source_node_id !== null) source.nodeId = row.source_node_id;
  if (row.source_message_id !== null) source.messageId = row.source_message_id;
  if (row.source_turn_id !== null) source.turnId = row.source_turn_id;
  if (row.source_artifact_id !== null) source.artifactId = row.source_artifact_id;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    scope: row.scope === 'workspace' && row.workspace_id !== null
      ? { kind: 'workspace', workspaceId: row.workspace_id }
      : { kind: 'user' },
    kind: row.kind,
    body: row.body,
    source: Object.keys(source).length > 0 ? source : null,
    status: row.status,
    origin: row.origin,
    version: row.version,
    supersedesId: row.supersedes_id,
    sourceRisk: row.source_risk,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

let savepointSerial = 0;
/** A savepoint, so memory writes compose with a caller's transaction (and its hooks' writes). */
export function memoryTransaction<T>(fn: () => T): T {
  const db = getDb();
  const name = `memory_${++savepointSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

/**
 * Whether ownerUserId may keep memories in this workspace: it exists, was not
 * permanently deleted, and belongs to the owner (workspaceOwnerMatches, the
 * same rule as every other owner-scoped repository).
 */
export function workspaceAccessible(ownerUserId: string, workspaceId: string): boolean {
  const row = getDb().prepare('SELECT owner_user_id, purged_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as { owner_user_id: string | null; purged_at: number | null } | undefined;
  return !!row && row.purged_at === null && workspaceOwnerMatches(row.owner_user_id, ownerUserId);
}

export interface NewMemoryRow {
  id: string;
  ownerUserId: string;
  workspaceId: string | null;
  kind: MemoryKind;
  body: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  source: MemorySource | null;
  sourceRisk: MemorySourceRisk | null;
  supersedesId: string | null;
  now: number;
}

export function insertMemoryRow(row: NewMemoryRow): MemoryRecord {
  getDb().prepare(`INSERT INTO memories (id, owner_user_id, scope, workspace_id, kind, body, status, origin,
      source_node_id, source_message_id, source_turn_id, source_artifact_id, source_risk, supersedes_id,
      version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
    row.id, row.ownerUserId, row.workspaceId === null ? 'user' : 'workspace', row.workspaceId,
    row.kind, row.body, row.status, row.origin,
    row.source?.nodeId ?? null, row.source?.messageId ?? null, row.source?.turnId ?? null, row.source?.artifactId ?? null,
    row.sourceRisk, row.supersedesId, row.now, row.now,
  );
  const stored = findMemory(row.ownerUserId, row.id);
  if (!stored) throw new Error('memory insert was not readable');
  return stored;
}

export function findMemory(ownerUserId: string, id: string): MemoryRecord | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE m.id = ? AND m.owner_user_id = ?`)
    .get(id, ownerUserId) as MemoryRow | undefined;
  return row ? toRecord(row) : null;
}

export interface MemoryRowChanges {
  workspaceId?: string | null;
  kind?: MemoryKind;
  body?: string;
  status?: MemoryStatus;
}

/**
 * Apply changes when the stored version still equals expectedVersion; the
 * version goes up by one. Null when the row is gone, not the owner's, or was
 * changed in the meantime.
 */
export function updateMemoryRow(
  ownerUserId: string, id: string, expectedVersion: number, changes: MemoryRowChanges, now: number,
): MemoryRecord | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (changes.workspaceId !== undefined) {
    sets.push('scope = ?', 'workspace_id = ?');
    params.push(changes.workspaceId === null ? 'user' : 'workspace', changes.workspaceId);
  }
  if (changes.kind !== undefined) { sets.push('kind = ?'); params.push(changes.kind); }
  if (changes.body !== undefined) { sets.push('body = ?'); params.push(changes.body); }
  if (changes.status !== undefined) { sets.push('status = ?'); params.push(changes.status); }
  sets.push('version = version + 1', 'updated_at = ?');
  params.push(now, id, ownerUserId, expectedVersion);
  const result = getDb().prepare(`UPDATE memories SET ${sets.join(', ')}
    WHERE id = ? AND owner_user_id = ? AND version = ?`).run(...params);
  return Number(result.changes) === 1 ? findMemory(ownerUserId, id) : null;
}

/** Hard delete; the FTS row goes with it (memories_fts_ad). */
export function deleteMemoryRow(ownerUserId: string, id: string): boolean {
  const result = getDb().prepare('DELETE FROM memories WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId);
  return Number(result.changes) === 1;
}

/** Which scopes a read covers: the user scope, and some or all of the owner's workspaces. */
export interface MemoryScopeFilter {
  user: boolean;
  workspaceIds: readonly string[] | 'all';
}

type SqlParam = string | number;

function scopeClause(filter: MemoryScopeFilter, params: SqlParam[]): string | null {
  const parts: string[] = [];
  if (filter.user) parts.push(`m.scope = 'user'`);
  if (filter.workspaceIds === 'all') {
    parts.push(`m.scope = 'workspace'`);
  } else if (filter.workspaceIds.length > 0) {
    parts.push(`(m.scope = 'workspace' AND m.workspace_id IN (${filter.workspaceIds.map(() => '?').join(', ')}))`);
    params.push(...filter.workspaceIds);
  }
  return parts.length > 0 ? `(${parts.join(' OR ')})` : null;
}

function statusClause(statuses: readonly MemoryStatus[], params: SqlParam[]): string {
  params.push(...statuses);
  return `m.status IN (${statuses.map(() => '?').join(', ')})`;
}

/**
 * Whitespace-separated terms of a search. The trigram index can only match a
 * term of three or more characters; shorter terms (such as two-character
 * Chinese words) are matched with LIKE instead.
 */
interface TextTerms {
  all: string[];
  indexed: string[];
  short: string[];
}

const MIN_TRIGRAM_CHARS = 3;

export function splitTerms(query: string): TextTerms {
  const all = query.split(/\s+/u).filter(Boolean);
  const indexed = all.filter((term) => [...term].length >= MIN_TRIGRAM_CHARS);
  const short = all.filter((term) => [...term].length < MIN_TRIGRAM_CHARS);
  return { all, indexed, short };
}

/** A quoted FTS5 string is literal: operators, columns filters and wildcards inside it mean nothing. */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** LIKE pattern for a literal substring, with ESCAPE '\'. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const LIKE = `m.body LIKE ? ESCAPE '\\'`;

export interface MemorySearchFilter {
  scope: MemoryScopeFilter;
  statuses: readonly MemoryStatus[];
  terms: TextTerms;
  limit: number;
}

/**
 * Ranked recall: a row matches when it contains any term. Rows containing
 * more of the terms come first, then by bm25 over the indexed terms, then the
 * most recently updated.
 */
export function searchMemoryRows(ownerUserId: string, filter: MemorySearchFilter): MemoryRecord[] {
  const { terms } = filter;
  if (terms.all.length === 0) return [];
  const params: SqlParam[] = [];
  const matched = terms.all.map(() => `(${LIKE})`).join(' + ');
  params.push(...terms.all.map(likePattern));
  let join = '';
  if (terms.indexed.length > 0) {
    join = `LEFT JOIN (SELECT rowid AS fts_rowid, bm25(memories_fts) AS fts_rank FROM memories_fts
      WHERE memories_fts MATCH ?) f ON f.fts_rowid = m.row_id`;
    params.push(terms.indexed.map(ftsPhrase).join(' OR '));
  }
  const where = ['m.owner_user_id = ?'];
  params.push(ownerUserId);
  const scope = scopeClause(filter.scope, params);
  if (!scope) return [];
  where.push(scope, statusClause(filter.statuses, params));
  const anyTerm = [
    ...(terms.indexed.length > 0 ? ['f.fts_rowid IS NOT NULL'] : []),
    ...terms.short.map(() => LIKE),
  ];
  params.push(...terms.short.map(likePattern));
  where.push(`(${anyTerm.join(' OR ')})`);
  params.push(filter.limit);
  const rank = terms.indexed.length > 0 ? 'f.fts_rank IS NULL, f.fts_rank, ' : '';
  const rows = getDb().prepare(`SELECT ${COLUMNS}, (${matched}) AS matched FROM memories m ${join}
    WHERE ${where.join(' AND ')}
    ORDER BY matched DESC, ${rank}m.updated_at DESC, m.row_id DESC
    LIMIT ?`).all(...params) as unknown as MemoryRow[];
  return rows.map(toRecord);
}

export interface MemoryListFilter {
  scope: MemoryScopeFilter;
  statuses: readonly MemoryStatus[];
  /** Every term must occur (a filter, not a ranking). */
  terms: TextTerms | null;
  /** Only rows older (smaller row_id) than this one. */
  beforeRowId: number | null;
  limit: number;
}

/** Newest first; one extra row tells the caller whether another page exists. */
export function listMemoryRows(ownerUserId: string, filter: MemoryListFilter): { records: MemoryRecord[]; lastRowId: number | null; more: boolean } {
  const params: SqlParam[] = [ownerUserId];
  const where = ['m.owner_user_id = ?'];
  const scope = scopeClause(filter.scope, params);
  if (!scope) return { records: [], lastRowId: null, more: false };
  where.push(scope, statusClause(filter.statuses, params));
  if (filter.terms && filter.terms.indexed.length > 0) {
    where.push('m.row_id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
    params.push(filter.terms.indexed.map(ftsPhrase).join(' AND '));
  }
  for (const term of filter.terms?.short ?? []) {
    where.push(LIKE);
    params.push(likePattern(term));
  }
  if (filter.beforeRowId !== null) {
    where.push('m.row_id < ?');
    params.push(filter.beforeRowId);
  }
  params.push(filter.limit + 1);
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE ${where.join(' AND ')}
    ORDER BY m.row_id DESC LIMIT ?`).all(...params) as unknown as MemoryRow[];
  const more = rows.length > filter.limit;
  const page = more ? rows.slice(0, filter.limit) : rows;
  return { records: page.map(toRecord), lastRowId: page.length > 0 ? page[page.length - 1].row_id : null, more };
}

const PINNED_KINDS: readonly MemoryKind[] = ['preference', 'convention'];
const PINNED_CANDIDATE_LIMIT = 200;

/** Active preferences and conventions: the user scope first, then the workspace; newest first in each. */
export function pinnedMemoryRows(ownerUserId: string, workspaceId: string | null): MemoryRecord[] {
  const params: SqlParam[] = [ownerUserId, ...PINNED_KINDS];
  let scope = `m.scope = 'user'`;
  if (workspaceId !== null) {
    scope = `(m.scope = 'user' OR (m.scope = 'workspace' AND m.workspace_id = ?))`;
    params.push(workspaceId);
  }
  params.push(PINNED_CANDIDATE_LIMIT);
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM memories m
    WHERE m.owner_user_id = ? AND m.status = 'active' AND m.kind IN (${PINNED_KINDS.map(() => '?').join(', ')}) AND ${scope}
    ORDER BY CASE m.scope WHEN 'user' THEN 0 ELSE 1 END, m.updated_at DESC, m.row_id DESC
    LIMIT ?`).all(...params) as unknown as MemoryRow[];
  return rows.map(toRecord);
}

export function bumpScopeVersion(ownerUserId: string, workspaceId: string | null, now: number): void {
  getDb().prepare(`INSERT INTO memory_scope_versions (owner_user_id, workspace_id, version, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (owner_user_id, workspace_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`)
    .run(ownerUserId, workspaceId ?? USER_SCOPE_KEY, now);
}

export function readScopeVersion(ownerUserId: string, workspaceId: string | null): number {
  const row = getDb().prepare('SELECT version FROM memory_scope_versions WHERE owner_user_id = ? AND workspace_id = ?')
    .get(ownerUserId, workspaceId ?? USER_SCOPE_KEY) as { version: number } | undefined;
  return row?.version ?? 0;
}

export function readMemoryMode(ownerUserId: string): MemoryMode | null {
  const row = getDb().prepare('SELECT mode FROM memory_settings WHERE owner_user_id = ?')
    .get(ownerUserId) as { mode: MemoryMode } | undefined;
  return row?.mode ?? null;
}

export function writeMemoryMode(ownerUserId: string, mode: MemoryMode, now: number): void {
  getDb().prepare(`INSERT INTO memory_settings (owner_user_id, mode, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (owner_user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`)
    .run(ownerUserId, mode, now);
}

/**
 * A permanently deleted workspace takes its memories and scope counter with
 * it (deleteWorkspace). Removal hooks do not run: nothing of the workspace is
 * left for them to protect.
 */
export function purgeWorkspaceMemories(workspaceId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM memories WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM memory_scope_versions WHERE workspace_id = ?').run(workspaceId);
  purgeWorkspaceExtraction(workspaceId);
}

/** A deleted account's memories, counters and settings (admin user deletion). */
export function purgeOwnerMemories(ownerUserId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM memories WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_scope_versions WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_settings WHERE owner_user_id = ?').run(ownerUserId);
  purgeOwnerExtraction(ownerUserId);
}
