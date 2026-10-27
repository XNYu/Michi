import { getDb } from '../db';
import {
  isValidChangeState, parseChangeSource, parseChangeTarget, parsePageChangeDto,
  parseTargetMutation, parseTargetSnapshot,
  type ApplicationState, type ChangeTarget, type PageChangeDto, type ProposalState,
} from 'michi-shared';
import { PageWriteError, requirePagesWorkspace, sourceNodeId } from './core';

type ChangeRow = {
  seq: number; id: string; owner_user_id: string; workspace_id: string; page_id: string | null;
  database_id: string | null; target_key: string; target: string; batch_id: string; op: string;
  before_json: string | null; after_json: string | null; forward_json: string; inverse_json: string;
  base_rev: number; applied_rev: number | null; previous_head_id: string | null; source: string;
  proposal_state: ProposalState; application_state: ApplicationState; created_at: number; resolved_at: number | null;
};

const json = (value: unknown): string => JSON.stringify(value);
const fail404 = (): never => { throw new PageWriteError(404, 'not_found', 'Page change not found'); };
const invalid = (message = 'Invalid page change'): never => { throw new PageWriteError(400, 'invalid', message); };

function readJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { throw new PageWriteError(409, 'invalid', 'Stored page change is invalid'); }
}

function decode(row: ChangeRow): PageChangeDto {
  const value = {
    id: row.id, seq: row.seq, batchId: row.batch_id, target: readJson(row.target), op: row.op,
    before: readJson(row.before_json), after: readJson(row.after_json), forward: readJson(row.forward_json),
    inverse: readJson(row.inverse_json), baseRev: row.base_rev, appliedRev: row.applied_rev,
    previousHeadId: row.previous_head_id, source: readJson(row.source), proposalState: row.proposal_state,
    applicationState: row.application_state, createdAt: row.created_at, resolvedAt: row.resolved_at,
  };
  const parsed = parsePageChangeDto(value);
  if (!parsed) throw new PageWriteError(409, 'invalid', 'Stored page change is invalid');
  return parsed;
}

function activeTarget(workspaceId: string, ownerUserId: string, target: ChangeTarget, write: boolean): { pageId: string | null; databaseId: string | null } {
  const db = getDb();
  if (target.kind === 'block') {
    const row = db.prepare('SELECT id,workspace_id FROM pages WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(target.pageId, ownerUserId) as { id: string; workspace_id: string } | undefined;
    if (!row) return fail404();
    if (row.workspace_id !== workspaceId) return fail404();
    requirePagesWorkspace(workspaceId, ownerUserId, write);
    return { pageId: row.id, databaseId: null };
  }
  const row = db.prepare('SELECT id,workspace_id FROM page_databases WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(target.databaseId, ownerUserId) as { id: string; workspace_id: string } | undefined;
  if (!row) return fail404();
  if (row.workspace_id !== workspaceId) return fail404();
  requirePagesWorkspace(workspaceId, ownerUserId, write);
  return { pageId: null, databaseId: row.id };
}

export function targetKey(target: ChangeTarget): string {
  const parsed = parseChangeTarget(target);
  if (!parsed) return invalid('Invalid change target');
  if (parsed.kind === 'block') return `block:${parsed.pageId}:${parsed.blockId}`;
  if (parsed.kind === 'row') return `row:${parsed.databaseId}:${parsed.rowId}`;
  return `database:${parsed.databaseId}`;
}

export function insertChange(ownerUserId: string, workspaceId: string, change: Omit<PageChangeDto, 'seq'>): PageChangeDto {
  if (!ownerUserId?.trim()) return invalid('Invalid owner');
  requirePagesWorkspace(workspaceId, ownerUserId, true);
  const target = parseChangeTarget(change.target);
  const source = parseChangeSource(change.source);
  if (!target || !source || !parseTargetSnapshot(change.before) && change.before !== null ||
    !parseTargetSnapshot(change.after) && change.after !== null || !parseTargetMutation(change.forward) ||
    !parseTargetMutation(change.inverse) || !isValidChangeState(change.proposalState, change.applicationState)) return invalid();
  const owner = activeTarget(workspaceId, ownerUserId, target, true);
  const candidate = parsePageChangeDto({ ...change, target, source, seq: 1 });
  if (!candidate) return invalid();
  const db = getDb();
  try {
    const result = db.prepare(`INSERT INTO page_changes
      (id,owner_user_id,workspace_id,page_id,database_id,target_key,target,batch_id,op,before_json,after_json,
       forward_json,inverse_json,base_rev,applied_rev,previous_head_id,source,source_node_id,proposal_state,
       application_state,created_at,resolved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(candidate.id, ownerUserId, workspaceId, owner.pageId, owner.databaseId, targetKey(target), json(target),
        candidate.batchId, candidate.op, candidate.before === null ? null : json(candidate.before),
        candidate.after === null ? null : json(candidate.after), json(candidate.forward), json(candidate.inverse),
        candidate.baseRev, candidate.appliedRev, candidate.previousHeadId, json(candidate.source), sourceNodeId(candidate.source),
        candidate.proposalState, candidate.applicationState, candidate.createdAt, candidate.resolvedAt);
    return { ...candidate, seq: Number(result.lastInsertRowid) };
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new PageWriteError(409, 'invalid', 'Page change already exists');
    throw error;
  }
}

export function getTargetHead(workspaceId: string, target: ChangeTarget): { headId: string | null; targetRevision: number } | null {
  const row = getDb().prepare('SELECT head_id,target_revision FROM page_target_heads WHERE workspace_id=? AND target_key=?')
    .get(workspaceId, targetKey(target)) as { head_id: string | null; target_revision: number } | undefined;
  return row ? { headId: row.head_id, targetRevision: row.target_revision } : null;
}

export function setTargetHead(workspaceId: string, target: ChangeTarget, head: { headId: string | null; targetRevision: number }): void {
  if (!Number.isSafeInteger(head.targetRevision) || head.targetRevision < 1 ||
    (head.headId !== null && (typeof head.headId !== 'string' || !head.headId.length || head.headId.length > 200))) return invalid('Invalid target head');
  getDb().prepare(`INSERT INTO page_target_heads(workspace_id,target_key,head_id,target_revision) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,target_key) DO UPDATE SET head_id=excluded.head_id,target_revision=excluded.target_revision`)
    .run(workspaceId, targetKey(target), head.headId, head.targetRevision);
}

/** Internal transaction helper for a structural target deletion. Callers own view invalidation. */
export function dismissPendingProposals(workspaceId: string, target: ChangeTarget, now: number, exceptChangeId?: string): number {
  if (!workspaceId?.trim() || !Number.isSafeInteger(now) || now < 0 ||
    (exceptChangeId !== undefined && (!exceptChangeId.length || exceptChangeId.length > 200))) return invalid('Invalid proposal dismissal');
  const key = targetKey(target);
  const result = getDb().prepare(`UPDATE page_changes SET proposal_state='dismissed',resolved_at=?
    WHERE workspace_id=? AND target_key=? AND proposal_state='pending' AND (? IS NULL OR id<>?)`)
    .run(now, workspaceId, key, exceptChangeId ?? null, exceptChangeId ?? null);
  return Number(result.changes);
}

export function getChange(id: string, ownerUserId: string, options: { write?: boolean } = {}): PageChangeDto {
  const row = getDb().prepare('SELECT * FROM page_changes WHERE id=? AND owner_user_id=?').get(id, ownerUserId) as ChangeRow | undefined;
  if (!row) return fail404();
  requirePagesWorkspace(row.workspace_id, ownerUserId, options.write === true);
  return decode(row);
}

type ChangeLifecyclePatch = Partial<Pick<PageChangeDto,
  'proposalState' | 'applicationState' | 'resolvedAt' | 'before' | 'after' | 'forward' | 'inverse' | 'baseRev' | 'appliedRev' | 'previousHeadId'>>;
const mutableFields = new Set<string>([
  'proposalState', 'applicationState', 'resolvedAt', 'before', 'after', 'forward', 'inverse', 'baseRev', 'appliedRev', 'previousHeadId',
]);
export function updateChange(id: string, ownerUserId: string, patch: ChangeLifecyclePatch): PageChangeDto {
  if (!patch || Object.keys(patch).some((key) => !mutableFields.has(key))) return invalid('Only change lifecycle fields may be updated');
  const current = getChange(id, ownerUserId, { write: true });
  const changesAcceptedContent = ['before', 'after', 'forward', 'inverse', 'baseRev', 'appliedRev', 'previousHeadId'].some((key) => key in patch);
  if (changesAcceptedContent && (current.proposalState !== 'pending' || patch.proposalState !== 'accepted')) {
    return invalid('Accepted proposal details can only be recorded while accepting a pending proposal');
  }
  const updated = { ...current, ...patch };
  if (!parsePageChangeDto(updated)) return invalid('Invalid change lifecycle state');
  const row = getDb().prepare(`UPDATE page_changes SET proposal_state=?,application_state=?,resolved_at=?,before_json=?,after_json=?,
    forward_json=?,inverse_json=?,base_rev=?,applied_rev=?,previous_head_id=?
    WHERE id=? AND owner_user_id=? RETURNING *`).get(updated.proposalState, updated.applicationState, updated.resolvedAt,
      updated.before === null ? null : json(updated.before), updated.after === null ? null : json(updated.after),
      json(updated.forward), json(updated.inverse), updated.baseRev, updated.appliedRev, updated.previousHeadId, id, ownerUserId) as ChangeRow | undefined;
  if (!row) return fail404();
  return decode(row);
}

export interface RelevantChangeOptions {
  afterSeq?: number; beforeSeq?: number; direction?: 'forward' | 'backward'; limit?: number; proposalState?: ProposalState; applicationState?: ApplicationState;
}
export function listRelevantChanges(pageId: string, ownerUserId: string, options: RelevantChangeOptions = {}): { changes: PageChangeDto[]; nextAfter: number; nextBefore: number | null; hasMore: boolean } {
  const page = getDb().prepare('SELECT id,workspace_id FROM pages WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(pageId, ownerUserId) as { id: string; workspace_id: string } | undefined;
  if (!page) return fail404();
  requirePagesWorkspace(page.workspace_id, ownerUserId);
  const direction = options.direction ?? 'forward';
  const after = options.afterSeq ?? 0, before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit = options.limit ?? 50;
  if (!['forward', 'backward'].includes(direction) || (direction === 'backward' && options.afterSeq !== undefined) ||
    (direction === 'forward' && options.beforeSeq !== undefined) || !Number.isSafeInteger(after) || after < 0 ||
    !Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalid('Invalid history cursor or limit');
  if (options.proposalState !== undefined && options.proposalState !== null && !['pending', 'accepted', 'dismissed'].includes(options.proposalState)) return invalid();
  if (options.applicationState !== undefined && options.applicationState !== null && !['applied', 'reverted'].includes(options.applicationState)) return invalid();
  const db = getDb();
  const refs = db.prepare(`SELECT r.database_id FROM page_database_refs r JOIN page_databases d ON d.id=r.database_id
    WHERE r.page_id=? AND d.owner_user_id=? AND d.workspace_id=? AND d.deleted_at IS NULL`).all(pageId, ownerUserId, page.workspace_id) as unknown as { database_id: string }[];
  const clauses = [`owner_user_id=?`, `workspace_id=?`, direction === 'backward' ? `seq<?` : `seq>?`, `(page_id=? OR database_id IN (${refs.length ? refs.map(() => '?').join(',') : "''"}))`];
  const params: Array<string | number | null> = [ownerUserId, page.workspace_id, direction === 'backward' ? before : after, pageId, ...refs.map((row) => row.database_id)];
  if (options.proposalState !== undefined) { clauses.push('proposal_state IS ?'); params.push(options.proposalState); }
  if (options.applicationState !== undefined) { clauses.push('application_state IS ?'); params.push(options.applicationState); }
  const rows = db.prepare(`SELECT * FROM page_changes WHERE ${clauses.join(' AND ')} ORDER BY seq ${direction === 'backward' ? 'DESC' : 'ASC'} LIMIT ?`).all(...params, limit + 1) as unknown as ChangeRow[];
  const hasMore = rows.length > limit;
  const changes = rows.slice(0, limit).map(decode);
  return { changes, nextAfter: direction === 'forward' ? changes.at(-1)?.seq ?? after : after,
    nextBefore: direction === 'backward' ? changes.at(-1)?.seq ?? null : null, hasMore };
}

export function listChangeBatch(batchId: string, ownerUserId: string, workspaceId: string): PageChangeDto[] {
  requirePagesWorkspace(workspaceId, ownerUserId);
  const rows = getDb().prepare('SELECT * FROM page_changes WHERE batch_id=? AND owner_user_id=? AND workspace_id=? ORDER BY seq')
    .all(batchId, ownerUserId, workspaceId) as unknown as ChangeRow[];
  return rows.map(decode);
}

export function getPageActivitySeen(pageId: string, ownerUserId: string): number {
  const page = getDb().prepare('SELECT workspace_id FROM pages WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(pageId, ownerUserId) as { workspace_id: string } | undefined;
  if (!page) return fail404();
  requirePagesWorkspace(page.workspace_id, ownerUserId);
  const row = getDb().prepare('SELECT last_seen_change_seq FROM page_activity_seen WHERE page_id=? AND owner_user_id=?').get(pageId, ownerUserId) as { last_seen_change_seq: number } | undefined;
  return row?.last_seen_change_seq ?? 0;
}

export function acknowledgePageActivity(pageId: string, ownerUserId: string, sequence: number): number {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return invalid('Invalid activity sequence');
  const page = getDb().prepare('SELECT workspace_id FROM pages WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(pageId, ownerUserId) as { workspace_id: string } | undefined;
  if (!page) return fail404();
  requirePagesWorkspace(page.workspace_id, ownerUserId, true);
  const db = getDb();
  const relevant = db.prepare(`SELECT MAX(seq) AS max_seq FROM page_changes c WHERE c.owner_user_id=? AND c.workspace_id=? AND c.seq<=?
    AND (c.page_id=? OR c.database_id IN (SELECT r.database_id FROM page_database_refs r JOIN page_databases d ON d.id=r.database_id
      WHERE r.page_id=? AND d.owner_user_id=? AND d.workspace_id=? AND d.deleted_at IS NULL))`)
    .get(ownerUserId, page.workspace_id, sequence, pageId, pageId, ownerUserId, page.workspace_id) as { max_seq: number | null };
  const bounded = max_seq(relevant.max_seq);
  const prior = getPageActivitySeen(pageId, ownerUserId);
  const value = Math.max(prior, bounded);
  db.prepare(`INSERT INTO page_activity_seen(owner_user_id,page_id,last_seen_change_seq) VALUES (?,?,?)
    ON CONFLICT(owner_user_id,page_id) DO UPDATE SET last_seen_change_seq=MAX(last_seen_change_seq,excluded.last_seen_change_seq)`)
    .run(ownerUserId, pageId, value);
  return value;
}

function max_seq(value: number | null): number { return value ?? 0; }

/** Task activity's reads; each is shaped for an index (see 0048_task_activity_indexes.sql and idx_page_changes_target). */
export const TASK_ACTIVITY_SQL = {
  pending: `SELECT * FROM page_changes WHERE owner_user_id=? AND database_id=? AND target_key LIKE 'row:%'
    AND proposal_state='pending' ORDER BY seq DESC LIMIT ?`,
  upkeep: `SELECT * FROM page_changes WHERE owner_user_id=? AND database_id=? AND target_key LIKE 'row:%'
    AND created_at>=? AND json_extract(source,'$.kind')='maintenance' ORDER BY created_at DESC, seq DESC LIMIT ?`,
  first: 'SELECT * FROM page_changes WHERE owner_user_id=? AND workspace_id=? AND database_id=? AND target_key=? ORDER BY seq LIMIT 1',
} as const;

/** A database's row suggestions still waiting on the person, newest first. */
export function pendingRowProposals(databaseId: string, ownerUserId: string, limit: number): PageChangeDto[] {
  const rows = getDb().prepare(TASK_ACTIVITY_SQL.pending).all(ownerUserId, databaseId, limit) as unknown as ChangeRow[];
  return rows.map(decode);
}

/** Background maintenance's row changes to a database since a time, oldest first: the newest `limit` of them. */
export function upkeepRowChanges(databaseId: string, ownerUserId: string, since: number, limit: number): PageChangeDto[] {
  const rows = getDb().prepare(TASK_ACTIVITY_SQL.upkeep).all(ownerUserId, databaseId, since, limit) as unknown as ChangeRow[];
  return rows.reverse().map(decode);
}

/** The first change Michi recorded for a row, if any. */
export function firstRowChange(databaseId: string, rowId: string, ownerUserId: string, workspaceId: string): PageChangeDto | null {
  const row = getDb().prepare(TASK_ACTIVITY_SQL.first).get(ownerUserId, workspaceId, databaseId, `row:${databaseId}:${rowId}`) as ChangeRow | undefined;
  return row ? decode(row) : null;
}
