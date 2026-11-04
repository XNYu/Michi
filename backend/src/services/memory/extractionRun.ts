import { randomUUID } from 'node:crypto';
import { ConversationUpdatesError, isSystemWorkspaceSettings } from 'michi-shared';
import { workspaceOwnerMatches } from '../agentOwner';
import { conversationCompletionCounter, readConversationUpdates } from '../conversationUpdates';
import { getDb, runInTransaction } from '../db';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { startOfLocalDay } from '../metaAgent/todayUsage';
import { getTurnTrust } from '../turnTrust';
import { detectCorrection } from './extractionPolicy';
import { memoryExtractionBootstrapInstructions, MEMORY_EXTRACTION_TOOL_NAMES } from './extractionProfile';
import {
  addExtractionUsage, advanceExtractionCursor, failOrphanedExtractionRuns, findSameBodyMemory, finishExtractionRun,
  getCommittedProposal, getExtractionCursorByJob, getExtractionRun, getExtractionState, insertCommittedProposal, insertExtractionRun,
  lastFinishedExtractionRun, latestTombstoneSeq, listExtractionCandidates, listExtractionSources, markExtractionBudgetExhausted,
  extractionTokensOn, pruneExtractionRuns, settleExtractionCandidate, tombstoneBlocks, type ExtractionCandidateRecord,
  type ExtractionCursor, type ExtractionRunRecord, type ExtractionSourceInput,
} from './extractionRepository';
import { createMemory, getMemorySettings, memoryVersion, MemoryError } from './memoryService';

/**
 * One automatic extraction execution, as the scheduler runs it for a
 * workspace's execution identity (see maintenanceCoordinator): discovery that
 * never starts a model, a bounded batch of newly completed turns, and a
 * settle step that commits the staged candidates and the cursor together
 * only when every source turn has a receipt.
 */

export const MEMORY_EXTRACTION_LIMITS = Object.freeze({
  /** Source turns one execution reads at most (halved after an execution ran out of budget). */
  maxSourcesPerExecution: 4,
  /** Characters of one user message memory_read_source returns. */
  userMessageChars: 8_000,
  /** Characters of one assistant reply it returns: the start and the end. */
  assistantHeadChars: 3_000,
  assistantTailChars: 1_000,
  /** Tokens one execution may use. Michi's running estimate gates its tools; the runtime's report is recorded. */
  executionTokenBudget: 200_000,
  /** Tokens an owner's extraction may use per local day (reported, else estimated). */
  dailyTokenLimit: 1_000_000,
  /** An execution starts only with at least this much of the daily limit left. */
  minExecutionBudget: 20_000,
  /** Invalid tool calls an execution may repair; the next one fails it. */
  maxRepairs: 2,
  /** Candidates one source turn may yield. */
  maxCandidatesPerSource: 5,
  /** Finished executions kept per workspace. */
  runsKept: 20,
  /** Scheduler timeout of one execution. */
  timeoutSeconds: 900,
});

export const EXTRACTION_RUN_ID_PREFIX = 'mxr-';

/** Tool schemas the runtime lists, before any call. */
const TOOL_CATALOG_TOKENS = 1_200;

/** Rough token count: CJK characters count one each, other text four characters per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[⺀-鿿가-힯豈-﫿＀-￯]/gu)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

// ── discovery ────────────────────────────────────────────────────────────────

interface WorkspaceRow { id: string; name: string; owner_user_id: string | null; settings: string | null; deleted_at: number | null; purged_at: number | null; archived_at: number | null; created_at: number }

export function extractionWorkspace(workspaceId: string, ownerUserId: string): WorkspaceRow | null {
  const row = getDb().prepare('SELECT id,name,owner_user_id,settings,deleted_at,purged_at,archived_at,created_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as WorkspaceRow | undefined;
  if (!row || row.deleted_at !== null || row.purged_at !== null || row.archived_at !== null) return null;
  if (!workspaceOwnerMatches(row.owner_user_id, ownerUserId) || isSystemWorkspaceSettings(row.settings)) return null;
  return row;
}

export function globalMaintenancePaused(ownerUserId: string): boolean {
  const row = getDb().prepare('SELECT paused FROM meta_agent_maintenance_state WHERE owner_user_id = ?').get(ownerUserId) as { paused: number } | undefined;
  return row?.paused === 1;
}

/** Tokens left today for the owner's extraction, after the floor that still starts an execution. */
export function extractionBudgetLeft(ownerUserId: string, now: number): number {
  return MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - extractionTokensOn(ownerUserId, startOfLocalDay(now));
}

export function extractionLocalOnly(): boolean {
  return process.env.MICHI_CLOUD !== '1';
}

export type ExtractionHold = 'off' | 'unsupported' | 'paused' | 'workspace_paused' | 'maintenance_paused' | 'budget_exhausted' | 'workspace_unavailable';

/** Why this consumer may not start an execution now, or null. Database reads only. */
export function extractionHold(cursor: ExtractionCursor, now: number): ExtractionHold | null {
  if (!extractionLocalOnly()) return 'unsupported';
  if (getMemorySettings(cursor.ownerUserId).mode !== 'auto') return 'off';
  if (getExtractionState(cursor.ownerUserId).paused) return 'paused';
  if (cursor.paused) return 'workspace_paused';
  if (globalMaintenancePaused(cursor.ownerUserId)) return 'maintenance_paused';
  if (!extractionWorkspace(cursor.workspaceId, cursor.ownerUserId)) return 'workspace_unavailable';
  if (extractionBudgetLeft(cursor.ownerUserId, now) < MEMORY_EXTRACTION_LIMITS.minExecutionBudget) return 'budget_exhausted';
  return null;
}

/**
 * Database-only discovery for one execution identity: whether new completed
 * turns wait and nothing holds it. Never creates a run, session or model call.
 */
export function memoryExtractionHasWork(input: { jobId: string; workspaceId: string; ownerUserId: string }, now: number): boolean {
  const cursor = getExtractionCursorByJob(input.jobId);
  if (!cursor || cursor.workspaceId !== input.workspaceId || cursor.ownerUserId !== input.ownerUserId) return false;
  if (conversationCompletionCounter(cursor.workspaceId) <= cursor.completionCursor) return false;
  const hold = extractionHold(cursor, now);
  if (hold === 'budget_exhausted') markExtractionBudgetExhausted(cursor.ownerUserId, startOfLocalDay(now), now);
  return hold === null;
}

// ── source turns ─────────────────────────────────────────────────────────────

export interface ExtractionSourceMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  truncated: boolean;
  /** detectCorrection on the user's own words; a hint, not proof. */
  correctionHint?: string;
}

interface BoundedRow { id: string; role: string; length: number; head: string; tail: string; metadata: string | null }

/**
 * The bounded text of one completed turn: its user message(s) and the reply,
 * the reply cut to its start and end. null when the turn can no longer be read.
 */
export function readExtractionSourceMessages(source: { nodeId: string; userMessageId: string; assistantMessageId: string }): ExtractionSourceMessage[] | null {
  const db = getDb();
  const bounds = db.prepare(`SELECT u.seq AS first, a.seq AS last FROM messages u JOIN messages a ON a.node_id = u.node_id
    JOIN nodes n ON n.id = u.node_id
    WHERE u.id = ? AND a.id = ? AND u.node_id = ? AND u.role = 'user' AND a.role = 'assistant'
      AND n.deleted_at IS NULL AND n.purged_at IS NULL`)
    .get(source.userMessageId, source.assistantMessageId, source.nodeId) as { first: number; last: number } | undefined;
  if (!bounds || bounds.first >= bounds.last) return null;
  const { userMessageChars, assistantHeadChars, assistantTailChars } = MEMORY_EXTRACTION_LIMITS;
  const rows = db.prepare(`SELECT id, role, length(content) AS length,
      substr(content, 1, CASE WHEN role = 'user' THEN ? ELSE ? END) AS head,
      CASE WHEN role = 'assistant' AND length(content) > ? THEN substr(content, -?) ELSE '' END AS tail,
      CASE WHEN role = 'user' THEN metadata ELSE NULL END AS metadata
    FROM messages WHERE node_id = ? AND seq BETWEEN ? AND ? AND role IN ('user', 'assistant') ORDER BY seq, id`)
    .all(userMessageChars, assistantHeadChars, assistantHeadChars + assistantTailChars, assistantTailChars,
      source.nodeId, bounds.first, bounds.last) as unknown as BoundedRow[];
  const messages: ExtractionSourceMessage[] = [];
  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* legacy metadata */ }
    const initial = row.id === source.userMessageId;
    const reply = row.id === source.assistantMessageId;
    // Another input between the turn's boundaries means they no longer identify one turn.
    if (!initial && !reply && (row.role !== 'user' || metadata?.steered !== true)) return null;
    if (row.role === 'user') {
      const text = row.head;
      const hint = detectCorrection(text);
      messages.push({ id: row.id, role: 'user', text, truncated: row.length > text.length,
        ...(hint.isCorrection && hint.pattern ? { correctionHint: hint.pattern } : {}) });
    } else {
      const head = stripSentinelsStreamingSafe(row.head);
      const tail = row.tail ? stripSentinelsStreamingSafe(row.tail) : '';
      const omitted = row.tail ? row.length - assistantHeadChars - assistantTailChars : 0;
      messages.push({ id: row.id, role: 'assistant', truncated: omitted > 0,
        text: omitted > 0 ? `${head}\n[… ${omitted} characters of this reply omitted …]\n${tail}` : head });
    }
  }
  return messages;
}

// ── planning ─────────────────────────────────────────────────────────────────

export type ExtractionPlan =
  | { kind: 'skip'; summary: string }
  | { kind: 'run'; id: string; prompt: string; configRevision: number; sources: number };

/** An execution's projected tokens: the context, re-read about twice per source turn. */
function projectedTokens(base: number, sourceTokens: number, sources: number): number {
  return (base + sourceTokens) * (2 * sources + 1);
}

/**
 * Claims the next batch for a scheduler run. A held consumer or a range with
 * no readable turn returns skip (the cursor passes unreadable turns without a
 * model). The batch, its untrusted flags and the memory version are durable
 * before the model sees anything.
 */
export function planMemoryExtractionRun(input: { jobId: string; workspaceId: string; ownerUserId: string; runId: string; now: number }): ExtractionPlan {
  const cursor = getExtractionCursorByJob(input.jobId);
  if (!cursor || cursor.workspaceId !== input.workspaceId || cursor.ownerUserId !== input.ownerUserId) {
    throw new Error('This automatic memory consumer no longer exists');
  }
  failOrphanedExtractionRuns(cursor.workspaceId, cursor.ownerUserId, input.now);
  const hold = extractionHold(cursor, input.now);
  if (hold) return { kind: 'skip', summary: holdSummary(hold) };
  const workspace = extractionWorkspace(cursor.workspaceId, cursor.ownerUserId)!;
  let feed;
  try {
    feed = readConversationUpdates({ workspaceId: cursor.workspaceId, ownerUserId: cursor.ownerUserId, backendConnectionId: 'local' },
      { after: cursor.completionCursor, includeMessages: false, limit: MEMORY_EXTRACTION_LIMITS.maxSourcesPerExecution });
  } catch (error) {
    if (error instanceof ConversationUpdatesError && error.code === 'navigation_disabled') {
      throw new Error('AI access to this workspace\'s conversations is turned off; automatic memory cannot read them');
    }
    throw error;
  }
  const readable = feed.turns.filter((turn) => !turn.contentUnavailable);
  if (readable.length === 0) {
    // Nothing readable up to nextAfter (archived, deleted or unreadable turns): move past it without a model.
    if (feed.nextAfter > cursor.completionCursor && cursor.jobId) {
      advanceExtractionCursor({ workspaceId: cursor.workspaceId, ownerUserId: cursor.ownerUserId, jobId: cursor.jobId,
        from: cursor.completionCursor, to: feed.nextAfter, now: input.now });
    }
    return { kind: 'skip', summary: 'No new conversation turns' };
  }

  const remaining = MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - extractionTokensOn(cursor.ownerUserId, startOfLocalDay(input.now));
  const budget = Math.min(MEMORY_EXTRACTION_LIMITS.executionTokenBudget, remaining);
  const instructions = memoryExtractionBootstrapInstructions();
  // Halve the batch after an execution that ran out of budget or reported more than it.
  const previous = lastFinishedExtractionRun(cursor.workspaceId, cursor.ownerUserId);
  const previousSources = previous ? listExtractionSources(previous.id).length : 0;
  const overran = !!previous && (previous.stoppedReason === 'budget' || (previous.reportedTokens ?? 0) > previous.tokenBudget);
  const maxSources = overran ? Math.max(1, Math.floor(previousSources / 2)) : MEMORY_EXTRACTION_LIMITS.maxSourcesPerExecution;

  const picked: ExtractionSourceInput[] = [];
  let sourceTokens = 0;
  const base = estimateTokens(instructions) + TOOL_CATALOG_TOKENS + 400;
  for (const turn of readable) {
    if (picked.length >= maxSources) break;
    const messages = readExtractionSourceMessages(turn);
    const tokens = messages ? estimateTokens(messages.map((message) => message.text).join('\n')) + 60 * messages.length : 50;
    if (picked.length > 0 && projectedTokens(base, sourceTokens + tokens, picked.length + 1) > budget) break;
    sourceTokens += tokens;
    picked.push({
      sourceTurnId: turn.turnId, nodeId: turn.nodeId, userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId,
      completionSeq: turn.completionSeq, completedAt: turn.completedAt,
      untrusted: getTurnTrust({ nodeId: turn.nodeId, turnId: turn.turnId }).untrusted,
      correctionPattern: messages?.find((message) => message.correctionHint)?.correctionHint ?? null,
    });
  }
  const last = picked[picked.length - 1]!;
  // Every turn between the cursor and the batch's end is in it, or unreadable.
  const through = picked.length === readable.length && !feed.hasMore ? feed.nextAfter : last.completionSeq;
  const id = `${EXTRACTION_RUN_ID_PREFIX}${randomUUID()}`;
  const prompt = extractionPrompt(workspace.name, picked);
  const caller = { ownerUserId: cursor.ownerUserId };
  insertExtractionRun({
    id, ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, jobId: input.jobId, runId: input.runId,
    configRevision: cursor.revision, after: cursor.completionCursor, through,
    memoryVersion: memoryVersion(caller, cursor.workspaceId), tombstoneMark: latestTombstoneSeq(cursor.ownerUserId),
    tokenBudget: budget, estimatedTokens: base + estimateTokens(prompt), now: input.now, sources: picked,
  });
  return { kind: 'run', id, prompt, configRevision: cursor.revision, sources: picked.length };
}

function holdSummary(hold: ExtractionHold): string {
  switch (hold) {
    case 'off': return 'Skipped: automatic memory is turned off';
    case 'unsupported': return 'Skipped: automatic memory runs only on the local backend';
    case 'paused': return 'Skipped: automatic memory is paused';
    case 'workspace_paused': return 'Skipped: automatic memory is paused for this workspace';
    case 'maintenance_paused': return 'Skipped: Meta agent maintenance is paused';
    case 'budget_exhausted': return 'Skipped: today\'s automatic memory token limit is reached';
    case 'workspace_unavailable': return 'Skipped: the workspace is archived, deleted or not a local workspace';
  }
}

function extractionPrompt(workspaceName: string, sources: ExtractionSourceInput[]): string {
  const [readSource, search, propose, noChange] = MEMORY_EXTRACTION_TOOL_NAMES;
  const index = sources.map((source) => ({
    sourceTurnId: source.sourceTurnId,
    completedAt: new Date(source.completedAt).toISOString(),
    ...(source.correctionPattern ? { correctionHint: source.correctionPattern } : {}),
    ...(source.untrusted ? { readUntrustedContent: true } : {}),
  }));
  return [
    `Automatic memory extraction for the workspace "${workspaceName}": ${sources.length} completed source turn${sources.length === 1 ? '' : 's'}.`,
    `For each source turn below, in order: read it with ${readSource}, search with ${search}, then record its receipt with ${propose} (one call per candidate) or one ${noChange} call with a reason.`,
    `A tool error explains what to fix; after ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repaired calls the next invalid call fails this execution. Only tool calls are recorded; your reply is not read.`,
    'Source turns (trusted index; ids only, the content comes from the read tool):',
    JSON.stringify(index),
  ].join('\n');
}

// ── settling ─────────────────────────────────────────────────────────────────

export type SettleStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface SettleExtractionInput {
  id: string; ownerUserId: string; status: SettleStatus; error: string | null; turnId: string | null;
  claimedBy: string; now: number;
}

/** Tokens the runtime reported on the run's reply, or null. */
function reportedTokens(turnId: string | null): number | null {
  if (!turnId) return null;
  const row = getDb().prepare(`SELECT m.metadata FROM turns t JOIN messages m ON m.id = t.assistant_message_id WHERE t.turn_id = ?`)
    .get(turnId) as { metadata: string | null } | undefined;
  if (!row?.metadata) return null;
  try {
    const usage = (JSON.parse(row.metadata) as { usageSummary?: { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown } }).usageSummary;
    if (!usage) return null;
    if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) return Math.round(usage.totalTokens);
    if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') return Math.round(usage.inputTokens + usage.outputTokens);
  } catch { /* unreadable metadata counts as unreported */ }
  return null;
}

/** The scheduler run still belongs to this process's lease, as finishRun requires. */
function ownsSchedulerRun(runId: string, claimedBy: string, now: number): boolean {
  return !!getDb().prepare(`SELECT 1 FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id = 1
    JOIN scheduler_execution_claims x ON x.run_id = r.id AND x.holder = l.holder AND x.generation = l.generation
    WHERE r.id = ? AND r.status = 'running' AND r.claimed_by = ? AND r.attention IS NULL AND l.holder = ? AND l.expires_at > ?`)
    .get(runId, claimedBy, claimedBy, now);
}

function chargeUsage(run: ExtractionRunRecord, turnId: string | null, now: number): { tokens: number; reported: number | null } {
  const reported = reportedTokens(turnId);
  const current = getExtractionRun(run.id, run.ownerUserId) ?? run;
  const tokens = reported ?? current.estimatedTokens;
  const dayStart = startOfLocalDay(now);
  const total = addExtractionUsage(run.ownerUserId, dayStart, tokens);
  if (total >= MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - MEMORY_EXTRACTION_LIMITS.minExecutionBudget) {
    markExtractionBudgetExhausted(run.ownerUserId, dayStart, now);
  }
  return { tokens, reported };
}

interface CommitCounts { proposed: number; dropped: number; noChange: number }

/** Commits one staged candidate inside the settle transaction; returns whether it became a pending memory. */
function commitCandidate(run: ExtractionRunRecord, candidate: ExtractionCandidateRecord, completedAt: number, untrusted: boolean, now: number): boolean {
  const drop = (reason: string) => { settleExtractionCandidate(run.id, candidate.idempotencyKey, { state: 'dropped', reason }); return false; };
  if (!candidate.body) return drop('missing_body');
  // A removal while this execution ran (or before it) wins over the candidate.
  if (tombstoneBlocks({ ownerUserId: run.ownerUserId, workspaceId: run.workspaceId, sourceTurnId: candidate.sourceTurnId,
    bodyHash: candidate.bodyHash, completedAt })) return drop('tombstoned');
  if (getCommittedProposal(candidate.idempotencyKey)) return drop('already_proposed');
  if (findSameBodyMemory(run.ownerUserId, run.workspaceId, candidate.bodyHash)) return drop('duplicate');
  const caller = { ownerUserId: run.ownerUserId };
  const base = {
    scope: { kind: 'workspace' as const, workspaceId: run.workspaceId }, kind: candidate.kind, body: candidate.body,
    source: { nodeId: listExtractionSources(run.id).find((source) => source.sourceTurnId === candidate.sourceTurnId)?.nodeId, turnId: candidate.sourceTurnId },
    status: 'pending' as const, origin: 'extracted' as const,
    sourceRisk: candidate.sourceRisk ?? (untrusted ? 'untrusted' as const : null),
  };
  let record;
  try {
    record = createMemory(caller, { ...base, supersedesId: candidate.supersedesId });
  } catch (error) {
    // The memory it corrects was removed or corrected meanwhile: the new statement still stands on its own.
    if (!(error instanceof MemoryError) || !candidate.supersedesId || (error.code !== 'not_found' && error.code !== 'invalid_state')) throw error;
    record = createMemory(caller, base);
  }
  insertCommittedProposal({ idempotencyKey: candidate.idempotencyKey, ownerUserId: run.ownerUserId, workspaceId: run.workspaceId,
    sourceTurnId: candidate.sourceTurnId, memoryId: record.id, scopeHint: candidate.scopeHint, runId: run.id, now });
  settleExtractionCandidate(run.id, candidate.idempotencyKey, { state: 'committed', memoryId: record.id });
  return true;
}

function countsSummary(counts: CommitCounts, sources: number): string {
  const parts = [
    counts.proposed && `proposed ${counts.proposed} memor${counts.proposed === 1 ? 'y' : 'ies'}`,
    counts.noChange && `nothing to save in ${counts.noChange} turn${counts.noChange === 1 ? '' : 's'}`,
    counts.dropped && `dropped ${counts.dropped} (deleted before or already saved)`,
  ].filter(Boolean);
  return `Automatic memory: read ${sources} turn${sources === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

/**
 * Settles an execution from its durable receipts, never from the reply. It
 * succeeds only when the turn completed, every source turn has a receipt and
 * the scheduler run is still owned; then the candidates and the cursor commit
 * in one transaction. Anything else keeps the cursor and drops the staged text.
 */
export function settleMemoryExtractionRun(input: SettleExtractionInput): { status: SettleStatus; summary: string | null; error: string | null } {
  const run = getExtractionRun(input.id, input.ownerUserId);
  if (!run || run.state !== 'active') return { status: 'failed', summary: null, error: 'Automatic memory run record is missing' };
  const { tokens, reported } = chargeUsage(run, input.turnId, input.now);
  const current = getExtractionRun(run.id, run.ownerUserId)!;
  const sources = listExtractionSources(run.id);
  const fail = (status: SettleStatus, error: string) => {
    finishExtractionRun({ id: run.id, state: status === 'cancelled' ? 'cancelled' : 'failed', summary: null, error, reportedTokens: reported ?? tokens, now: input.now });
    pruneExtractionRuns(run.workspaceId, run.ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
    return { status: status === 'succeeded' ? 'failed' as const : status, summary: null, error };
  };
  if (input.status !== 'succeeded') {
    return fail(input.status, input.status === 'cancelled' ? 'Cancelled' : input.error ?? 'The Meta agent stopped before finishing');
  }
  if (current.stoppedReason === 'invalid_limit') {
    return fail('failed', `The Meta agent made ${current.invalidCalls} invalid tool calls (at most ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repairs); nothing was saved and the turns are retried`);
  }
  if (getMemorySettings(run.ownerUserId).mode !== 'auto') return fail('cancelled', 'Automatic memory was turned off during this run; nothing was saved');
  const missing = sources.filter((source) => source.decision === null);
  if (missing.length) {
    const reason = current.stoppedReason === 'budget' ? ' after reaching this run\'s token budget' : '';
    return fail('failed', `The Meta agent finished${reason} without a receipt for ${missing.length} of ${sources.length} source turn${sources.length === 1 ? '' : 's'}; nothing was saved and the turns are retried`);
  }
  let outcome: { counts: CommitCounts } | { error: string };
  try {
    outcome = runInTransaction(() => {
      if (!ownsSchedulerRun(run.runId, input.claimedBy, input.now)) return { error: 'The scheduler no longer owns this run; nothing was saved' };
      const fresh = getExtractionRun(run.id, run.ownerUserId);
      if (!fresh || fresh.state !== 'active') return { error: 'Automatic memory run already settled' };
      if (!advanceExtractionCursor({ workspaceId: run.workspaceId, ownerUserId: run.ownerUserId, jobId: run.jobId, from: run.after, to: run.through, now: input.now })) {
        return { error: 'The workspace\'s automatic memory cursor moved; nothing was saved' };
      }
      const counts: CommitCounts = { proposed: 0, dropped: 0, noChange: sources.filter((source) => source.decision === 'no_change').length };
      const bySource = new Map(sources.map((source) => [source.sourceTurnId, source]));
      for (const candidate of listExtractionCandidates(run.id)) {
        if (candidate.state === 'dropped') { counts.dropped += 1; continue; }
        if (candidate.state !== 'staged') continue;
        const source = bySource.get(candidate.sourceTurnId)!;
        if (commitCandidate(run, candidate, source.completedAt, source.untrusted, input.now)) counts.proposed += 1;
        else counts.dropped += 1;
      }
      finishExtractionRun({ id: run.id, state: 'succeeded', summary: countsSummary(counts, sources.length), error: null,
        reportedTokens: reported ?? tokens, counts, now: input.now });
      return { counts };
    });
  } catch (error) {
    log.warn('scheduler', 'automatic memory commit failed', { runId: run.id, error: error instanceof Error ? error.message : String(error) });
    return fail('failed', `Saving the proposals failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ('error' in outcome) return fail('failed', outcome.error);
  pruneExtractionRuns(run.workspaceId, run.ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
  const over = reported !== null && reported > run.tokenBudget ? ` · used ${reported} tokens, over this run's ${run.tokenBudget}` : '';
  return { status: 'succeeded', summary: `${countsSummary(outcome.counts, sources.length)}${over}`, error: null };
}

/** Records an execution that ended without settling (setup failed or the scheduler stopped it). */
export function failMemoryExtractionRun(id: string, ownerUserId: string, error: string, now: number, cancelled = false): void {
  const run = getExtractionRun(id, ownerUserId);
  if (!run || run.state !== 'active') return;
  finishExtractionRun({ id, state: cancelled ? 'cancelled' : 'failed', summary: null, error: cancelled ? 'Cancelled' : error,
    reportedTokens: null, now });
}
