import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export type HomeRunKind = 'first-run' | 'home-summary';
export type HomeRunState = 'active' | 'written' | 'no_change' | 'failed' | 'superseded';

export interface HomeRunRecord {
  id: string; kind: HomeRunKind; ownerUserId: string; workspaceId: string; jobId: string; runId: string;
  targetPageId: string; fingerprint: string | null; state: HomeRunState; payloadHash: string | null;
  result: unknown; error: string | null; createdAt: number; updatedAt: number;
}

export interface HomeState {
  ownerUserId: string; requestedAt: number;
  summaryFingerprint: string | null; summarizedAt: number | null;
  summaryFailedFingerprint: string | null; summaryFailures: number; summaryFailedAt: number | null;
  cardsJson: string | null; cardsFingerprint: string | null; cardsRendered: string | null;
  haltedReason: string | null; haltedAt: number | null; updatedAt: number;
}

type RunRow = {
  id: string; kind: HomeRunKind; owner_user_id: string; workspace_id: string; job_id: string; run_id: string;
  target_page_id: string; fingerprint: string | null; state: HomeRunState; payload_hash: string | null;
  result_json: string | null; error: string | null; created_at: number; updated_at: number;
};
type StateRow = {
  owner_user_id: string; requested_at: number; summary_fingerprint: string | null; summarized_at: number | null;
  summary_failed_fingerprint: string | null; summary_failures: number; summary_failed_at: number | null;
  cards_json: string | null; cards_fingerprint: string | null; cards_rendered: string | null;
  halted_reason: string | null; halted_at: number | null; updated_at: number;
};

const db = () => getDb();
const ERROR_MAX = 2_000;

function runDto(row: RunRow): HomeRunRecord {
  return { id: row.id, kind: row.kind, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id, jobId: row.job_id,
    runId: row.run_id, targetPageId: row.target_page_id, fingerprint: row.fingerprint, state: row.state,
    payloadHash: row.payload_hash, result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function stateDto(row: StateRow): HomeState {
  return { ownerUserId: row.owner_user_id, requestedAt: row.requested_at, summaryFingerprint: row.summary_fingerprint,
    summarizedAt: row.summarized_at, summaryFailedFingerprint: row.summary_failed_fingerprint,
    summaryFailures: row.summary_failures, summaryFailedAt: row.summary_failed_at, cardsJson: row.cards_json,
    cardsFingerprint: row.cards_fingerprint, cardsRendered: row.cards_rendered, haltedReason: row.halted_reason,
    haltedAt: row.halted_at, updatedAt: row.updated_at };
}

export function getHomeState(ownerUserId: string): HomeState | null {
  const row = db().prepare('SELECT * FROM meta_agent_home_state WHERE owner_user_id=?').get(ownerUserId) as StateRow | undefined;
  return row ? stateDto(row) : null;
}

/** Owners who opened Spaces on this connection; only they get first runs and summaries. */
export function listHomeStateOwners(): string[] {
  return (db().prepare('SELECT owner_user_id FROM meta_agent_home_state ORDER BY owner_user_id').all() as Array<{ owner_user_id: string }>)
    .map((row) => row.owner_user_id);
}

export function ensureHomeState(ownerUserId: string, now: number): HomeState {
  db().prepare('INSERT OR IGNORE INTO meta_agent_home_state(owner_user_id,requested_at,updated_at) VALUES(?,?,?)').run(ownerUserId, now, now);
  return getHomeState(ownerUserId)!;
}

type StatePatch = Partial<Pick<StateRow, 'summary_fingerprint' | 'summarized_at' | 'summary_failed_fingerprint' |
  'summary_failures' | 'summary_failed_at' | 'cards_json' | 'cards_fingerprint' | 'cards_rendered' | 'halted_reason' | 'halted_at'>>;

export function updateHomeState(ownerUserId: string, patch: StatePatch, now: number): void {
  const keys = Object.keys(patch) as Array<keyof StatePatch>;
  if (!keys.length) return;
  db().prepare(`UPDATE meta_agent_home_state SET ${keys.map((key) => `${key}=?`).join(',')},updated_at=? WHERE owner_user_id=?`)
    .run(...keys.map((key) => patch[key] ?? null), now, ownerUserId);
}

/** A run still counts as active only while its scheduler run is running. */
const LIVE_RUN = `EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id=h.run_id AND r.job_id=h.job_id AND r.status='running')`;

/** Supersedes earlier active runs of the same scope whose scheduler run has ended (a restart or a timeout). */
function supersedeStale(kind: HomeRunKind, ownerUserId: string, workspaceId: string, now: number): void {
  const scope = kind === 'first-run' ? 'AND h.workspace_id=?' : '';
  db().prepare(`UPDATE meta_agent_home_runs AS h SET state='superseded',updated_at=? WHERE h.kind=? AND h.owner_user_id=? ${scope}
    AND h.state='active' AND NOT ${LIVE_RUN}`).run(now, kind, ownerUserId, ...(kind === 'first-run' ? [workspaceId] : []));
}

/** A run whose scheduler run is still going, whether or not it has recorded its decision yet. */
export function liveHomeRun(kind: HomeRunKind, ownerUserId: string, workspaceId?: string): HomeRunRecord | null {
  const row = db().prepare(`SELECT h.* FROM meta_agent_home_runs h WHERE h.kind=? AND h.owner_user_id=? AND h.state<>'superseded'
    ${workspaceId ? 'AND h.workspace_id=?' : ''} AND ${LIVE_RUN} ORDER BY h.created_at DESC LIMIT 1`)
    .get(kind, ownerUserId, ...(workspaceId ? [workspaceId] : [])) as RunRow | undefined;
  return row ? runDto(row) : null;
}

export interface CreateHomeRunInput {
  kind: HomeRunKind; ownerUserId: string; workspaceId: string; jobId: string; runId: string;
  targetPageId: string; fingerprint: string | null; now: number;
}

/** Returns null when another live run of the same scope already owns the work. */
export function createHomeRun(input: CreateHomeRunInput): HomeRunRecord | null {
  supersedeStale(input.kind, input.ownerUserId, input.workspaceId, input.now);
  if (liveHomeRun(input.kind, input.ownerUserId, input.kind === 'first-run' ? input.workspaceId : undefined)) return null;
  const id = `mhr-${randomUUID()}`;
  db().prepare(`INSERT INTO meta_agent_home_runs(id,kind,owner_user_id,workspace_id,job_id,run_id,target_page_id,fingerprint,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'active',?,?)`).run(id, input.kind, input.ownerUserId, input.workspaceId, input.jobId, input.runId,
    input.targetPageId, input.fingerprint, input.now, input.now);
  return getHomeRun(id, input.ownerUserId);
}

export function getHomeRun(id: string, ownerUserId: string): HomeRunRecord | null {
  const row = db().prepare('SELECT * FROM meta_agent_home_runs WHERE id=? AND owner_user_id=?').get(id, ownerUserId) as RunRow | undefined;
  return row ? runDto(row) : null;
}

/** The newest finished summary read these homes: a later one that read other homes means the page no longer reflects them. */
export function finishedSummaryRun(ownerUserId: string, fingerprint: string): boolean {
  const latest = db().prepare(`SELECT fingerprint FROM meta_agent_home_runs WHERE kind='home-summary' AND owner_user_id=?
    AND state IN ('written','no_change') ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(ownerUserId) as { fingerprint: string | null } | undefined;
  return latest?.fingerprint === fingerprint;
}

/** Records a run's final decision; only an active run moves, so a receipt is written once. */
export function finishHomeRun(id: string, outcome: { state: Exclude<HomeRunState, 'active'>; payloadHash?: string; result?: unknown; error?: string }, now: number): boolean {
  const changed = db().prepare(`UPDATE meta_agent_home_runs SET state=?,payload_hash=?,result_json=?,error=?,updated_at=? WHERE id=? AND state='active'`)
    .run(outcome.state, outcome.payloadHash ?? null, outcome.result === undefined ? null : JSON.stringify(outcome.result),
      outcome.error ? outcome.error.slice(0, ERROR_MAX) : null, now, id);
  return Number(changed.changes) === 1;
}

export function recordFirstRunReads(workspaceId: string, ownerUserId: string, nodeIds: readonly string[], now: number): void {
  const insert = db().prepare('INSERT OR IGNORE INTO meta_agent_first_run_reads(workspace_id,owner_user_id,node_id,read_at) VALUES(?,?,?,?)');
  for (const nodeId of nodeIds) insert.run(workspaceId, ownerUserId, nodeId, now);
}

export function firstRunReadNodeIds(workspaceId: string, ownerUserId: string): string[] {
  return (db().prepare('SELECT node_id FROM meta_agent_first_run_reads WHERE workspace_id=? AND owner_user_id=? ORDER BY read_at DESC,node_id')
    .all(workspaceId, ownerUserId) as Array<{ node_id: string }>).map((row) => row.node_id);
}

export function clearFirstRunReads(workspaceId: string, ownerUserId: string): void {
  db().prepare('DELETE FROM meta_agent_first_run_reads WHERE workspace_id=? AND owner_user_id=?').run(workspaceId, ownerUserId);
}
