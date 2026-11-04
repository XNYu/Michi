import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryExtractionScopeHint } from 'michi-shared';
import { getDb } from '../db';

/**
 * Storage for automatic memory extraction (migration 0061). Every query
 * names its owner; callers in extractionRun.ts and extractionTools.ts decide
 * what is allowed. Nothing here stores the text of a deleted memory.
 */

const db = () => getDb();

// ── body identity ────────────────────────────────────────────────────────────

/** Case, width and spacing differences, and closing punctuation, do not make a different memory. */
export function normalizeMemoryBody(body: string): string {
  return body.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[\s。．.!！?？;；,，、]+$/u, '');
}

export function memoryBodyHash(body: string): string {
  return createHash('sha256').update(normalizeMemoryBody(body), 'utf8').digest('hex');
}

/** One proposal per owner, workspace, source turn and normalized body. */
export function extractionIdempotencyKey(input: { ownerUserId: string; workspaceId: string; sourceTurnId: string; bodyHash: string }): string {
  return createHash('sha256').update(JSON.stringify(['memory-extraction', 1, input.ownerUserId, input.workspaceId, input.sourceTurnId, input.bodyHash])).digest('hex');
}

// ── owner state ──────────────────────────────────────────────────────────────

export interface ExtractionOwnerState { paused: boolean; enabledAt: number | null }

export function getExtractionState(ownerUserId: string, database: DatabaseSync = db()): ExtractionOwnerState {
  const row = database.prepare('SELECT paused, enabled_at FROM memory_extraction_state WHERE owner_user_id = ?').get(ownerUserId) as
    { paused: number; enabled_at: number | null } | undefined;
  return { paused: row?.paused === 1, enabledAt: row?.enabled_at ?? null };
}

export function setExtractionPaused(ownerUserId: string, paused: boolean, now: number): void {
  db().prepare(`INSERT INTO memory_extraction_state(owner_user_id, paused, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`).run(ownerUserId, paused ? 1 : 0, now);
}

/** The time auto mode was first switched on, recording `now` the first time. */
export function ensureExtractionEnabledAt(ownerUserId: string, now: number): number {
  db().prepare(`INSERT INTO memory_extraction_state(owner_user_id, enabled_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET enabled_at = COALESCE(memory_extraction_state.enabled_at, excluded.enabled_at),
      updated_at = CASE WHEN memory_extraction_state.enabled_at IS NULL THEN excluded.updated_at ELSE memory_extraction_state.updated_at END`)
    .run(ownerUserId, now, now);
  return getExtractionState(ownerUserId).enabledAt!;
}

/**
 * Auto mode was switched back on: conversations from while it was off are
 * never read. Every existing consumer moves forward to `cursorFor` (never
 * back), and enabledAt becomes `now`, so a workspace created while auto mode
 * was off also starts at its current position. The revision bump fences any
 * execution still holding an older claim.
 */
export function restartExtractionAt(ownerUserId: string, cursorFor: (workspaceId: string) => number, now: number): void {
  const database = db();
  const workspaces = database.prepare('SELECT workspace_id FROM memory_extraction_cursors WHERE owner_user_id = ?')
    .all(ownerUserId) as Array<{ workspace_id: string }>;
  const move = database.prepare(`UPDATE memory_extraction_cursors
    SET completion_cursor = MAX(completion_cursor, ?), revision = revision + 1, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ?`);
  // A savepoint, so this composes with a caller's transaction.
  database.exec('SAVEPOINT extraction_restart');
  try {
    for (const { workspace_id: workspaceId } of workspaces) move.run(cursorFor(workspaceId), now, workspaceId, ownerUserId);
    database.prepare(`INSERT INTO memory_extraction_state(owner_user_id, enabled_at, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(owner_user_id) DO UPDATE SET enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`)
      .run(ownerUserId, now, now);
    database.exec('RELEASE SAVEPOINT extraction_restart');
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT extraction_restart');
    database.exec('RELEASE SAVEPOINT extraction_restart');
    throw error;
  }
}

/** Owners whose memory mode is auto. */
export function listAutoModeOwners(): string[] {
  return (db().prepare("SELECT owner_user_id FROM memory_settings WHERE mode = 'auto' ORDER BY owner_user_id").all() as Array<{ owner_user_id: string }>)
    .map((row) => row.owner_user_id);
}

// ── cursors ──────────────────────────────────────────────────────────────────

export interface ExtractionCursor {
  workspaceId: string; ownerUserId: string; jobId: string | null; completionCursor: number;
  paused: boolean; revision: number; createdAt: number; updatedAt: number;
}

interface CursorRow {
  workspace_id: string; owner_user_id: string; job_id: string | null; completion_cursor: number;
  paused: number; revision: number; created_at: number; updated_at: number;
}

function cursorDto(row: CursorRow): ExtractionCursor {
  return { workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, jobId: row.job_id, completionCursor: row.completion_cursor,
    paused: row.paused === 1, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getExtractionCursor(workspaceId: string, ownerUserId: string): ExtractionCursor | null {
  const row = db().prepare('SELECT * FROM memory_extraction_cursors WHERE workspace_id = ? AND owner_user_id = ?').get(workspaceId, ownerUserId) as CursorRow | undefined;
  return row ? cursorDto(row) : null;
}

export function getExtractionCursorByJob(jobId: string): ExtractionCursor | null {
  const row = db().prepare('SELECT * FROM memory_extraction_cursors WHERE job_id = ?').get(jobId) as CursorRow | undefined;
  return row ? cursorDto(row) : null;
}

/** Creates a workspace's consumer at `cursor`; an existing one keeps its own cursor. */
export function insertExtractionCursor(input: { workspaceId: string; ownerUserId: string; cursor: number; now: number }): void {
  db().prepare(`INSERT INTO memory_extraction_cursors(workspace_id, owner_user_id, job_id, completion_cursor, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(workspace_id, owner_user_id) DO NOTHING`)
    .run(input.workspaceId, input.ownerUserId, input.cursor, input.now, input.now);
}

export function setExtractionCursorJob(workspaceId: string, ownerUserId: string, jobId: string, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_cursors SET job_id = ?, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ? AND job_id IS NULL`).run(jobId, now, workspaceId, ownerUserId);
  return Number(changed.changes) === 1;
}

/** Cursors whose execution identity is missing or was deleted (for example with its workspace's scheduled jobs). */
export function listExtractionCursorsWithoutJob(ownerUserId: string): ExtractionCursor[] {
  return (db().prepare(`SELECT c.* FROM memory_extraction_cursors c
      WHERE c.owner_user_id = ? AND (c.job_id IS NULL OR NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.id = c.job_id))
      ORDER BY c.created_at, c.workspace_id`).all(ownerUserId) as unknown as CursorRow[]).map(cursorDto);
}

export function clearExtractionCursorJob(workspaceId: string, ownerUserId: string, now: number): void {
  db().prepare('UPDATE memory_extraction_cursors SET job_id = NULL, updated_at = ? WHERE workspace_id = ? AND owner_user_id = ?')
    .run(now, workspaceId, ownerUserId);
}

export function setExtractionWorkspacePaused(workspaceId: string, ownerUserId: string, paused: boolean, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_cursors SET paused = ?, revision = revision + 1, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ?`).run(paused ? 1 : 0, now, workspaceId, ownerUserId);
  return Number(changed.changes) === 1;
}

/** Compare-and-set; false when the cursor moved or the consumer was reconfigured. */
export function advanceExtractionCursor(input: { workspaceId: string; ownerUserId: string; jobId: string; from: number; to: number; now: number }): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_cursors SET completion_cursor = ?, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ? AND job_id = ? AND completion_cursor = ?`)
    .run(input.to, input.now, input.workspaceId, input.ownerUserId, input.jobId, input.from);
  return Number(changed.changes) === 1;
}

/** Each consumer with its execution identity's scheduler state (repeated-failure stop). */
export function listExtractionJobStates(ownerUserId: string): Array<ExtractionCursor & { autoPaused: boolean; lastError: string | null }> {
  return (db().prepare(`SELECT c.*, COALESCE(j.auto_paused, 0) AS auto_paused, j.last_error FROM memory_extraction_cursors c
      LEFT JOIN scheduled_jobs j ON j.id = c.job_id WHERE c.owner_user_id = ? ORDER BY c.created_at, c.workspace_id`).all(ownerUserId) as unknown as
    Array<CursorRow & { auto_paused: number; last_error: string | null }>)
    .map((row) => ({ ...cursorDto(row), autoPaused: row.auto_paused === 1, lastError: row.last_error }));
}

export function isMemoryExtractionJob(jobId: string): boolean {
  return !!db().prepare('SELECT 1 FROM memory_extraction_cursors WHERE job_id = ?').get(jobId);
}

/** The execution identities of an owner's extraction consumers (usage accounting). */
export function memoryExtractionJobIds(ownerUserId: string, database: DatabaseSync = db()): string[] {
  return (database.prepare('SELECT job_id FROM memory_extraction_cursors WHERE owner_user_id = ? AND job_id IS NOT NULL ORDER BY job_id')
    .all(ownerUserId) as Array<{ job_id: string }>).map((row) => row.job_id);
}

// ── executions ───────────────────────────────────────────────────────────────

export type ExtractionRunState = 'active' | 'succeeded' | 'failed' | 'cancelled';
export type ExtractionStopReason = 'invalid_limit' | 'budget';

export interface ExtractionRunRecord {
  id: string; ownerUserId: string; workspaceId: string; jobId: string; runId: string; configRevision: number;
  after: number; through: number; memoryVersion: number; tombstoneMark: number; state: ExtractionRunState;
  invalidCalls: number; stoppedReason: ExtractionStopReason | null; tokenBudget: number; estimatedTokens: number;
  reportedTokens: number | null; proposedCount: number; droppedCount: number; noChangeCount: number;
  summary: string | null; error: string | null; startedAt: number; finishedAt: number | null;
}

interface RunRow {
  id: string; owner_user_id: string; workspace_id: string; job_id: string; run_id: string; config_revision: number;
  after_seq: number; through_seq: number; memory_version: number; tombstone_mark: number; state: ExtractionRunState;
  invalid_calls: number; stopped_reason: ExtractionStopReason | null; token_budget: number; estimated_tokens: number;
  reported_tokens: number | null; proposed_count: number; dropped_count: number; no_change_count: number;
  summary: string | null; error: string | null; started_at: number; finished_at: number | null;
}

function runDto(row: RunRow): ExtractionRunRecord {
  return { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id, jobId: row.job_id, runId: row.run_id,
    configRevision: row.config_revision, after: row.after_seq, through: row.through_seq, memoryVersion: row.memory_version,
    tombstoneMark: row.tombstone_mark, state: row.state, invalidCalls: row.invalid_calls, stoppedReason: row.stopped_reason,
    tokenBudget: row.token_budget, estimatedTokens: row.estimated_tokens, reportedTokens: row.reported_tokens,
    proposedCount: row.proposed_count, droppedCount: row.dropped_count, noChangeCount: row.no_change_count,
    summary: row.summary, error: row.error, startedAt: row.started_at, finishedAt: row.finished_at };
}

export interface ExtractionSourceInput {
  sourceTurnId: string; nodeId: string; userMessageId: string; assistantMessageId: string;
  completionSeq: number; completedAt: number; untrusted: boolean; correctionPattern: string | null;
}

export function insertExtractionRun(input: {
  id: string; ownerUserId: string; workspaceId: string; jobId: string; runId: string; configRevision: number;
  after: number; through: number; memoryVersion: number; tombstoneMark: number; tokenBudget: number; estimatedTokens: number;
  now: number; sources: ExtractionSourceInput[];
}): void {
  db().prepare(`INSERT INTO memory_extraction_runs(id, owner_user_id, workspace_id, job_id, run_id, config_revision, after_seq, through_seq,
      memory_version, tombstone_mark, state, token_budget, context_tokens, estimated_tokens, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(input.id, input.ownerUserId, input.workspaceId, input.jobId, input.runId, input.configRevision, input.after, input.through,
      input.memoryVersion, input.tombstoneMark, input.tokenBudget, input.estimatedTokens, input.estimatedTokens, input.now);
  const source = db().prepare(`INSERT INTO memory_extraction_sources(run_id, source_turn_id, node_id, user_message_id, assistant_message_id,
      completion_seq, completed_at, untrusted, correction_pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of input.sources) {
    source.run(input.id, item.sourceTurnId, item.nodeId, item.userMessageId, item.assistantMessageId, item.completionSeq,
      item.completedAt, item.untrusted ? 1 : 0, item.correctionPattern);
  }
}

export function getExtractionRun(id: string, ownerUserId: string): ExtractionRunRecord | null {
  const row = db().prepare('SELECT * FROM memory_extraction_runs WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as RunRow | undefined;
  return row ? runDto(row) : null;
}

/** Runs still marked active whose scheduler run is no longer running: the process stopped under them. */
export function failOrphanedExtractionRuns(workspaceId: string, ownerUserId: string, now: number): void {
  db().prepare(`UPDATE memory_extraction_runs AS x SET state = 'failed', error = 'The run stopped before it finished', finished_at = ?
    WHERE x.workspace_id = ? AND x.owner_user_id = ? AND x.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id = x.run_id AND r.status = 'running')`).run(now, workspaceId, ownerUserId);
}

export function listRecentExtractionRuns(ownerUserId: string, limit: number, database: DatabaseSync = db()): ExtractionRunRecord[] {
  return (database.prepare('SELECT * FROM memory_extraction_runs WHERE owner_user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
    .all(ownerUserId, limit) as unknown as RunRow[]).map(runDto);
}

/** The newest finished run of a workspace, for batch sizing after a budget failure. */
export function lastFinishedExtractionRun(workspaceId: string, ownerUserId: string): ExtractionRunRecord | null {
  const row = db().prepare(`SELECT * FROM memory_extraction_runs WHERE workspace_id = ? AND owner_user_id = ? AND state <> 'active'
    ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(workspaceId, ownerUserId) as RunRow | undefined;
  return row ? runDto(row) : null;
}

export function liveExtractionRunCount(ownerUserId: string): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM memory_extraction_runs x WHERE x.owner_user_id = ? AND x.state = 'active'
    AND EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id = x.run_id AND r.status = 'running')`).get(ownerUserId) as { n: number }).n;
}

export function isExtractionRunLive(id: string): boolean {
  return !!db().prepare(`SELECT 1 FROM memory_extraction_runs x JOIN scheduled_job_runs r ON r.id = x.run_id
    WHERE x.id = ? AND x.state = 'active' AND r.status = 'running'`).get(id);
}

export function recordExtractionInvalidCall(id: string, limit: number): { invalidCalls: number; stopped: boolean } {
  db().prepare(`UPDATE memory_extraction_runs SET invalid_calls = invalid_calls + 1,
      stopped_reason = CASE WHEN invalid_calls + 1 > ? AND stopped_reason IS NULL THEN 'invalid_limit' ELSE stopped_reason END
    WHERE id = ? AND state = 'active'`).run(limit, id);
  const row = db().prepare('SELECT invalid_calls, stopped_reason FROM memory_extraction_runs WHERE id = ?').get(id) as { invalid_calls: number; stopped_reason: string | null } | undefined;
  return { invalidCalls: row?.invalid_calls ?? 0, stopped: row?.stopped_reason === 'invalid_limit' };
}

/**
 * Charges one tool call to the run's estimate: its arguments and result join
 * the context, and the model reads the whole context again for its next step.
 * Returns the new estimate.
 */
export function chargeExtractionCall(id: string, callTokens: number): number {
  const tokens = Math.max(0, Math.ceil(callTokens));
  db().prepare(`UPDATE memory_extraction_runs SET context_tokens = context_tokens + ?,
      estimated_tokens = estimated_tokens + context_tokens + ? WHERE id = ? AND state = 'active'`).run(tokens, tokens, id);
  return (db().prepare('SELECT estimated_tokens FROM memory_extraction_runs WHERE id = ?').get(id) as { estimated_tokens: number } | undefined)?.estimated_tokens ?? 0;
}

export function stopExtractionRun(id: string, reason: ExtractionStopReason): void {
  db().prepare("UPDATE memory_extraction_runs SET stopped_reason = COALESCE(stopped_reason, ?) WHERE id = ? AND state = 'active'").run(reason, id);
}

export function finishExtractionRun(input: {
  id: string; state: Exclude<ExtractionRunState, 'active'>; summary: string | null; error: string | null; reportedTokens: number | null;
  counts?: { proposed: number; dropped: number; noChange: number }; now: number;
}): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_runs SET state = ?, summary = ?, error = ?, reported_tokens = ?,
      proposed_count = COALESCE(?, proposed_count), dropped_count = COALESCE(?, dropped_count), no_change_count = COALESCE(?, no_change_count),
      finished_at = ? WHERE id = ? AND state = 'active'`)
    .run(input.state, input.summary, input.error ? input.error.slice(0, 2000) : null, input.reportedTokens,
      input.counts?.proposed ?? null, input.counts?.dropped ?? null, input.counts?.noChange ?? null, input.now, input.id);
  if (Number(changed.changes) === 1 && input.state !== 'succeeded') {
    // A run that does not commit keeps no candidate text.
    db().prepare("UPDATE memory_extraction_candidates SET body = NULL, state = 'dropped', drop_reason = COALESCE(drop_reason, 'run_not_committed') WHERE run_id = ? AND state = 'staged'")
      .run(input.id);
  }
  return Number(changed.changes) === 1;
}

/** Keep the latest runs per workspace; their sources and candidates cascade. */
export function pruneExtractionRuns(workspaceId: string, ownerUserId: string, keep: number): void {
  db().prepare(`DELETE FROM memory_extraction_runs WHERE workspace_id = ? AND owner_user_id = ? AND state <> 'active' AND id NOT IN (
      SELECT id FROM memory_extraction_runs WHERE workspace_id = ? AND owner_user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`)
    .run(workspaceId, ownerUserId, workspaceId, ownerUserId, keep);
}

// ── sources and receipts ─────────────────────────────────────────────────────

export interface ExtractionSourceRecord extends ExtractionSourceInput {
  readAt: number | null; decision: 'proposed' | 'no_change' | null; reason: string | null;
}

interface SourceRow {
  source_turn_id: string; node_id: string; user_message_id: string; assistant_message_id: string; completion_seq: number;
  completed_at: number; untrusted: number; correction_pattern: string | null; read_at: number | null;
  decision: 'proposed' | 'no_change' | null; reason: string | null;
}

function sourceDto(row: SourceRow): ExtractionSourceRecord {
  return { sourceTurnId: row.source_turn_id, nodeId: row.node_id, userMessageId: row.user_message_id, assistantMessageId: row.assistant_message_id,
    completionSeq: row.completion_seq, completedAt: row.completed_at, untrusted: row.untrusted === 1, correctionPattern: row.correction_pattern,
    readAt: row.read_at, decision: row.decision, reason: row.reason };
}

export function markExtractionSourceRead(runId: string, sourceTurnId: string, now: number): void {
  db().prepare('UPDATE memory_extraction_sources SET read_at = COALESCE(read_at, ?) WHERE run_id = ? AND source_turn_id = ?').run(now, runId, sourceTurnId);
}

export function listExtractionSources(runId: string): ExtractionSourceRecord[] {
  return (db().prepare('SELECT * FROM memory_extraction_sources WHERE run_id = ? ORDER BY completion_seq, source_turn_id').all(runId) as unknown as SourceRow[]).map(sourceDto);
}

export function extractionSourceCount(runId: string): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM memory_extraction_sources WHERE run_id = ?').get(runId) as { n: number }).n;
}

export function getExtractionSource(runId: string, sourceTurnId: string): ExtractionSourceRecord | null {
  const row = db().prepare('SELECT * FROM memory_extraction_sources WHERE run_id = ? AND source_turn_id = ?').get(runId, sourceTurnId) as SourceRow | undefined;
  return row ? sourceDto(row) : null;
}

/** Records a receipt once: a no-change keeps its first reason; a turn never holds both kinds. */
export function recordExtractionDecision(runId: string, sourceTurnId: string, decision: 'proposed' | 'no_change', reason: string | null, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_sources SET decision = ?, reason = ?, decided_at = ?
    WHERE run_id = ? AND source_turn_id = ? AND (decision IS NULL OR (decision = 'proposed' AND ? = 'proposed'))`)
    .run(decision, reason, now, runId, sourceTurnId, decision);
  return Number(changed.changes) === 1;
}

// ── candidates and the proposal ledger ───────────────────────────────────────

export interface ExtractionCandidateRecord {
  runId: string; idempotencyKey: string; sourceTurnId: string; body: string | null; bodyHash: string; kind: MemoryKind;
  scopeHint: MemoryExtractionScopeHint; supersedesId: string | null; sourceRisk: 'untrusted' | null;
  state: 'staged' | 'committed' | 'dropped'; dropReason: string | null; memoryId: string | null;
}

interface CandidateRow {
  run_id: string; idempotency_key: string; source_turn_id: string; body: string | null; body_hash: string; kind: MemoryKind;
  scope_hint: MemoryExtractionScopeHint; supersedes_id: string | null; source_risk: 'untrusted' | null;
  state: 'staged' | 'committed' | 'dropped'; drop_reason: string | null; memory_id: string | null;
}

function candidateDto(row: CandidateRow): ExtractionCandidateRecord {
  return { runId: row.run_id, idempotencyKey: row.idempotency_key, sourceTurnId: row.source_turn_id, body: row.body, bodyHash: row.body_hash,
    kind: row.kind, scopeHint: row.scope_hint, supersedesId: row.supersedes_id, sourceRisk: row.source_risk, state: row.state,
    dropReason: row.drop_reason, memoryId: row.memory_id };
}

export function getExtractionCandidate(runId: string, idempotencyKey: string): ExtractionCandidateRecord | null {
  const row = db().prepare('SELECT * FROM memory_extraction_candidates WHERE run_id = ? AND idempotency_key = ?').get(runId, idempotencyKey) as CandidateRow | undefined;
  return row ? candidateDto(row) : null;
}

export function listExtractionCandidates(runId: string): ExtractionCandidateRecord[] {
  return (db().prepare('SELECT * FROM memory_extraction_candidates WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as unknown as CandidateRow[]).map(candidateDto);
}

export function insertExtractionCandidate(input: {
  runId: string; idempotencyKey: string; sourceTurnId: string; body: string | null; bodyHash: string; kind: MemoryKind;
  scopeHint: MemoryExtractionScopeHint; supersedesId: string | null; sourceRisk: 'untrusted' | null;
  state: 'staged' | 'dropped'; dropReason: string | null; memoryId?: string | null; now: number;
}): void {
  db().prepare(`INSERT INTO memory_extraction_candidates(run_id, idempotency_key, source_turn_id, body, body_hash, kind, scope_hint,
      supersedes_id, source_risk, state, drop_reason, memory_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.runId, input.idempotencyKey, input.sourceTurnId, input.state === 'staged' ? input.body : null, input.bodyHash, input.kind,
      input.scopeHint, input.supersedesId, input.sourceRisk, input.state, input.dropReason, input.memoryId ?? null, input.now);
}

export function settleExtractionCandidate(runId: string, idempotencyKey: string, outcome: { state: 'committed'; memoryId: string } | { state: 'dropped'; reason: string }): void {
  db().prepare(`UPDATE memory_extraction_candidates SET state = ?, body = NULL, memory_id = ?, drop_reason = ?
    WHERE run_id = ? AND idempotency_key = ? AND state = 'staged'`)
    .run(outcome.state, outcome.state === 'committed' ? outcome.memoryId : null, outcome.state === 'dropped' ? outcome.reason : null, runId, idempotencyKey);
}

export function getCommittedProposal(idempotencyKey: string): { memoryId: string; runId: string } | null {
  const row = db().prepare('SELECT memory_id, run_id FROM memory_extraction_proposals WHERE idempotency_key = ?').get(idempotencyKey) as
    { memory_id: string; run_id: string } | undefined;
  return row ? { memoryId: row.memory_id, runId: row.run_id } : null;
}

export function insertCommittedProposal(input: {
  idempotencyKey: string; ownerUserId: string; workspaceId: string; sourceTurnId: string; memoryId: string;
  scopeHint: MemoryExtractionScopeHint; runId: string; now: number;
}): void {
  db().prepare(`INSERT INTO memory_extraction_proposals(idempotency_key, owner_user_id, workspace_id, source_turn_id, memory_id, scope_hint, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.idempotencyKey, input.ownerUserId, input.workspaceId, input.sourceTurnId, input.memoryId,
    input.scopeHint, input.runId, input.now);
}

/** Pending extracted memories whose candidate suggested making them global. */
export function pendingMaybeGlobalMemoryIds(ownerUserId: string): string[] {
  return (db().prepare(`SELECT p.memory_id FROM memory_extraction_proposals p JOIN memories m ON m.id = p.memory_id
      WHERE p.owner_user_id = ? AND m.owner_user_id = ? AND m.status = 'pending' AND p.scope_hint = 'maybe_global'
      ORDER BY p.created_at, p.memory_id`).all(ownerUserId, ownerUserId) as Array<{ memory_id: string }>).map((row) => row.memory_id);
}

export function pendingExtractedMemoryCount(ownerUserId: string): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM memories WHERE owner_user_id = ? AND status = 'pending' AND origin = 'extracted'")
    .get(ownerUserId) as { n: number }).n;
}

/** An active or pending memory in this workspace or the owner's user scope with the same normalized body. */
export function findSameBodyMemory(ownerUserId: string, workspaceId: string, bodyHash: string): string | null {
  const rows = db().prepare(`SELECT id, body FROM memories WHERE owner_user_id = ? AND status IN ('active', 'pending')
      AND (workspace_id IS NULL OR workspace_id = ?)`).all(ownerUserId, workspaceId) as Array<{ id: string; body: string }>;
  return rows.find((row) => memoryBodyHash(row.body) === bodyHash)?.id ?? null;
}

// ── tombstones ───────────────────────────────────────────────────────────────

export function insertExtractionTombstone(input: {
  ownerUserId: string; workspaceId: string | null; sourceTurnId: string | null; bodyHash: string; reason: 'deleted' | 'rejected'; now: number;
}): void {
  db().prepare(`INSERT INTO memory_extraction_tombstones(owner_user_id, workspace_id, source_turn_id, body_hash, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.ownerUserId, input.workspaceId, input.sourceTurnId, input.bodyHash, input.reason, input.now);
}

export function latestTombstoneSeq(ownerUserId: string): number {
  return (db().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_extraction_tombstones WHERE owner_user_id = ?').get(ownerUserId) as { seq: number }).seq;
}

/**
 * Whether a removal forbids proposing this candidate: one from the same
 * source turn, or one with the same body in this workspace (or the user
 * scope) removed after the source turn completed. A statement made again in
 * a turn that completed after the removal is a new expression and passes.
 */
export function tombstoneBlocks(input: { ownerUserId: string; workspaceId: string; sourceTurnId: string; bodyHash: string; completedAt: number }): 'source_turn' | 'body' | null {
  if (db().prepare('SELECT 1 FROM memory_extraction_tombstones WHERE owner_user_id = ? AND source_turn_id = ? LIMIT 1').get(input.ownerUserId, input.sourceTurnId)) {
    return 'source_turn';
  }
  const body = db().prepare(`SELECT 1 FROM memory_extraction_tombstones WHERE owner_user_id = ? AND body_hash = ?
    AND (workspace_id IS NULL OR workspace_id = ?) AND created_at >= ? LIMIT 1`)
    .get(input.ownerUserId, input.bodyHash, input.workspaceId, input.completedAt);
  return body ? 'body' : null;
}

// ── usage ────────────────────────────────────────────────────────────────────

export function addExtractionUsage(ownerUserId: string, dayStart: number, tokens: number): number {
  db().prepare(`INSERT INTO memory_extraction_usage(owner_user_id, day_start, tokens, executions) VALUES (?, ?, ?, 1)
    ON CONFLICT(owner_user_id, day_start) DO UPDATE SET tokens = memory_extraction_usage.tokens + excluded.tokens,
      executions = memory_extraction_usage.executions + 1`).run(ownerUserId, dayStart, Math.max(0, Math.round(tokens)));
  return extractionTokensOn(ownerUserId, dayStart);
}

export function extractionTokensOn(ownerUserId: string, dayStart: number, database: DatabaseSync = db()): number {
  return (database.prepare('SELECT tokens FROM memory_extraction_usage WHERE owner_user_id = ? AND day_start = ?').get(ownerUserId, dayStart) as
    { tokens: number } | undefined)?.tokens ?? 0;
}

export function markExtractionBudgetExhausted(ownerUserId: string, dayStart: number, now: number): void {
  db().prepare(`INSERT INTO memory_extraction_usage(owner_user_id, day_start, exhausted_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id, day_start) DO UPDATE SET exhausted_at = COALESCE(memory_extraction_usage.exhausted_at, excluded.exhausted_at)`)
    .run(ownerUserId, dayStart, now);
}

// ── purge ────────────────────────────────────────────────────────────────────

/** A permanently deleted workspace takes its extraction state, receipts and tombstones with it. */
export function purgeWorkspaceExtraction(workspaceId: string): void {
  const database = db();
  database.prepare('DELETE FROM memory_extraction_runs WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_cursors WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_proposals WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_tombstones WHERE workspace_id = ?').run(workspaceId);
}

/** A deleted account's extraction state, receipts, tombstones and usage. */
export function purgeOwnerExtraction(ownerUserId: string): void {
  const database = db();
  database.prepare('DELETE FROM memory_extraction_runs WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_cursors WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_proposals WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_tombstones WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_usage WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_state WHERE owner_user_id = ?').run(ownerUserId);
}
