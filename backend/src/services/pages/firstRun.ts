import { isSystemWorkspaceSettings, type FirstRunProgressDto, type FirstRunState } from 'michi-shared';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError, pagesTransaction, requirePagesWorkspace } from './core';

type FirstRunRow = {
  workspace_id: string; owner_user_id: string; started_at: number; start_seq: number; read_count: number;
  total: number; state: FirstRunState; error: string | null; updated_at: number;
};

const ERROR_MAX = 2_000;
/** A failed run is restarted with queueFirstRun, never moved on in place; done is final. */
const NEXT: Record<FirstRunState, readonly FirstRunState[]> = {
  queued: ['queued', 'reading', 'writing', 'done', 'failed'],
  reading: ['reading', 'writing', 'failed'],
  writing: ['writing', 'done', 'failed'],
  done: [],
  failed: [],
};

const count = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return value as number;
};

function requireUserWorkspace(workspaceId: string, ownerUserId: string, write = false): void {
  const workspace = requirePagesWorkspace(workspaceId, ownerUserId, write);
  if (isSystemWorkspaceSettings(workspace.settings)) throw new PageWriteError(404, 'not_found', 'Workspace not found');
}

function dto(row: FirstRunRow): FirstRunProgressDto {
  return { workspaceId: row.workspace_id, startedAt: row.started_at, startSeq: row.start_seq, readCount: row.read_count,
    total: row.total, state: row.state, error: row.error, updatedAt: row.updated_at };
}

function row(workspaceId: string, ownerUserId: string): FirstRunRow | undefined {
  return getDb().prepare('SELECT * FROM page_first_runs WHERE workspace_id=? AND owner_user_id=?').get(workspaceId, ownerUserId) as FirstRunRow | undefined;
}

export function getFirstRun(workspaceId: string, ownerUserId: string): FirstRunProgressDto | null {
  requireUserWorkspace(workspaceId, ownerUserId);
  const found = row(workspaceId, ownerUserId);
  return found ? dto(found) : null;
}

/** Progress for every live workspace of the owner's, oldest run first. */
export function listFirstRuns(ownerUserId: string): FirstRunProgressDto[] {
  const rows = getDb().prepare(`SELECT f.*,w.owner_user_id AS workspace_owner FROM page_first_runs f JOIN workspaces w ON w.id=f.workspace_id
    WHERE f.owner_user_id=? AND w.deleted_at IS NULL AND w.purged_at IS NULL ORDER BY f.started_at,f.workspace_id`)
    .all(ownerUserId) as unknown as Array<FirstRunRow & { workspace_owner: string | null }>;
  return rows.filter((entry) => workspaceOwnerMatches(entry.workspace_owner, ownerUserId)).map(dto);
}

export interface QueueFirstRunInput { workspaceId: string; ownerUserId: string; startSeq: number; total: number; now?: number }

/**
 * Queues a workspace's first read. A run already queued, in progress or done
 * is returned unchanged, so a restarted generator resumes instead of
 * rewriting; a failed run starts over from the given counter.
 */
export function queueFirstRun(input: QueueFirstRunInput): FirstRunProgressDto {
  const startSeq = count(input.startSeq, 'startSeq');
  const total = count(input.total, 'total');
  const now = count(input.now ?? Date.now(), 'timestamp');
  return pagesTransaction(() => {
    requireUserWorkspace(input.workspaceId, input.ownerUserId, true);
    const current = row(input.workspaceId, input.ownerUserId);
    if (current && current.state !== 'failed') return dto(current);
    getDb().prepare(`INSERT INTO page_first_runs(workspace_id,owner_user_id,started_at,start_seq,read_count,total,state,error,updated_at)
      VALUES(?,?,?,?,0,?,'queued',NULL,?) ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET
      started_at=excluded.started_at,start_seq=excluded.start_seq,read_count=0,total=excluded.total,state='queued',error=NULL,updated_at=excluded.updated_at`)
      .run(input.workspaceId, input.ownerUserId, now, startSeq, total, now);
    return dto(row(input.workspaceId, input.ownerUserId)!);
  });
}

export interface UpdateFirstRunInput {
  workspaceId: string; ownerUserId: string; state?: FirstRunState; readCount?: number; total?: number; error?: string; now?: number;
}

export function updateFirstRun(input: UpdateFirstRunInput): FirstRunProgressDto {
  const now = count(input.now ?? Date.now(), 'timestamp');
  return pagesTransaction(() => {
    requireUserWorkspace(input.workspaceId, input.ownerUserId, true);
    const current = row(input.workspaceId, input.ownerUserId);
    if (!current) throw new PageWriteError(404, 'not_found', 'First run not found');
    const state = input.state ?? current.state;
    if (!NEXT[current.state].includes(state)) throw new PageWriteError(409, 'invalid', `First run cannot move from ${current.state} to ${state}`);
    const readCount = input.readCount === undefined ? current.read_count : count(input.readCount, 'readCount');
    const total = input.total === undefined ? current.total : count(input.total, 'total');
    if (readCount < current.read_count || readCount > total) throw new PageWriteError(400, 'invalid', 'readCount must not decrease or exceed total');
    let error: string | null = null;
    if (state === 'failed') {
      error = typeof input.error === 'string' ? input.error.trim().slice(0, ERROR_MAX) : '';
      if (!error) throw new PageWriteError(400, 'invalid', 'A failed first run needs an error');
    } else if (input.error !== undefined) {
      throw new PageWriteError(400, 'invalid', 'Only a failed first run has an error');
    }
    getDb().prepare('UPDATE page_first_runs SET state=?,read_count=?,total=?,error=?,updated_at=? WHERE workspace_id=? AND owner_user_id=?')
      .run(state, readCount, total, error, now, input.workspaceId, input.ownerUserId);
    return dto(row(input.workspaceId, input.ownerUserId)!);
  });
}
