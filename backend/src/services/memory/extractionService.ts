import { isSystemWorkspaceSettings, type MemoryExtractionStatus, type MemoryExtractionState, type ScheduledJobSchedule } from 'michi-shared';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { workspaceOwnerMatches } from '../agentOwner';
import { conversationCompletionCounter } from '../conversationUpdates';
import { getDb } from '../db';
import { log } from '../logger';
import { resolveMetaAgentRuntime } from '../metaAgent/settings';
import { startOfLocalDay } from '../metaAgent/todayUsage';
import { EXTRACTION_EXCLUSIONS } from './extractionPolicy';
import {
  clearExtractionCursorJob, ensureExtractionEnabledAt, extractionSourceCount, extractionTokensOn, getExtractionCursor, getExtractionState,
  insertExtractionCursor, insertExtractionTombstone, isExtractionRunLive, listAutoModeOwners, listExtractionCursorsWithoutJob, listExtractionJobStates,
  listRecentExtractionRuns, liveExtractionRunCount, memoryBodyHash, pendingExtractedMemoryCount, pendingMaybeGlobalMemoryIds,
  restartExtractionAt, setExtractionCursorJob, setExtractionPaused, setExtractionWorkspacePaused,
} from './extractionRepository';
import { extractionLocalOnly, extractionWorkspace, globalMaintenancePaused, MEMORY_EXTRACTION_LIMITS } from './extractionRun';
import { getMemorySettings, memoryEvents, MemoryError, onMemoryRemoved, type MemorySettingsChangedEvent } from './memoryService';

/**
 * Wiring of automatic memory extraction: enrollment of a workspace's
 * completion-feed consumer, the tombstone hook on removed memories, the C5
 * status and the pause/resume/cancel controls. The scheduler owns execution
 * (scheduler.ts, maintenanceCoordinator.ts); this module only creates the
 * execution identities it runs and asks it to cancel or wake them.
 */

/** The scheduler surface this module uses. */
export interface MemoryExtractionScheduler {
  createMaintenanceExecution(raw: unknown, ownerUserId: string): { id: string };
  deleteJob(id: string): void;
  updateJob(id: string, raw: unknown): unknown;
  cancelActiveRun(jobId: string): boolean;
  wakeJobs(jobIds: readonly string[]): void;
}

const UNSUPPORTED_REASON = 'Automatic memory runs only on a local Michi backend with background jobs; explicit memory still works.';

const EXECUTION_PROMPT = 'Extract pending memory candidates from completed conversation turns. Record only verified receipts.';

let attachedScheduler: MemoryExtractionScheduler | null = null;

/** The running scheduler, for waking and cancelling extraction runs from settings changes. */
export function attachMemoryExtractionScheduler(scheduler: MemoryExtractionScheduler): () => void {
  attachedScheduler = scheduler;
  return () => { if (attachedScheduler === scheduler) attachedScheduler = null; };
}

// ── enrollment ───────────────────────────────────────────────────────────────

function enrollableWorkspaces(ownerUserId: string): Array<{ id: string; createdAt: number }> {
  const rows = getDb().prepare(`SELECT id, owner_user_id, settings, created_at FROM workspaces
    WHERE deleted_at IS NULL AND purged_at IS NULL AND archived_at IS NULL ORDER BY created_at, id`).all() as
    Array<{ id: string; owner_user_id: string | null; settings: string | null; created_at: number }>;
  return rows.filter((row) => workspaceOwnerMatches(row.owner_user_id, ownerUserId) && !isSystemWorkspaceSettings(row.settings))
    .map((row) => ({ id: row.id, createdAt: row.created_at }));
}

/**
 * Creates the missing per-workspace cursors of an owner in auto mode. Turning
 * auto mode on starts every existing workspace at its current completion
 * position (no backfill); a workspace created after that starts at 0. Pausing
 * keeps the cursors, so resuming continues where extraction stopped; leaving
 * auto mode and returning skips what happened meanwhile (onSettingsChanged).
 * Database only.
 */
export function enrollMemoryExtraction(ownerUserId: string, now: number): void {
  if (!extractionLocalOnly() || getMemorySettings(ownerUserId).mode !== 'auto') return;
  const enabledAt = getExtractionState(ownerUserId).enabledAt ?? ensureExtractionEnabledAt(ownerUserId, now);
  for (const workspace of enrollableWorkspaces(ownerUserId)) {
    if (getExtractionCursor(workspace.id, ownerUserId)) continue;
    insertExtractionCursor({ workspaceId: workspace.id, ownerUserId,
      cursor: workspace.createdAt > enabledAt ? 0 : conversationCompletionCounter(workspace.id), now });
  }
}

/**
 * Called from each scheduler tick: enrolls new workspaces of owners in auto
 * mode and gives every consumer its execution identity in the shared ledger.
 */
export function sweepMemoryExtraction(scheduler: MemoryExtractionScheduler, now: number): void {
  if (!extractionLocalOnly()) return;
  for (const ownerUserId of listAutoModeOwners()) {
    try {
      enrollMemoryExtraction(ownerUserId, now);
      for (const cursor of listExtractionCursorsWithoutJob(ownerUserId)) {
        if (!extractionWorkspace(cursor.workspaceId, ownerUserId)) continue;
        if (cursor.jobId) clearExtractionCursorJob(cursor.workspaceId, ownerUserId, now);
        const job = scheduler.createMaintenanceExecution({
          workspaceId: cursor.workspaceId, name: 'Automatic memory', prompt: EXECUTION_PROMPT,
          schedule: { kind: 'every', everySeconds: 60 } satisfies ScheduledJobSchedule,
          runtimeId: null, providerId: null, modelId: null, reasoning: null,
          permissionMode: 'trust', sessionMode: 'fresh', notify: false, enabled: true,
          timeoutSeconds: MEMORY_EXTRACTION_LIMITS.timeoutSeconds, conversationUpdates: false,
        }, ownerUserId);
        if (!setExtractionCursorJob(cursor.workspaceId, ownerUserId, job.id, now)) scheduler.deleteJob(job.id);
      }
    } catch (error) {
      log.warn('scheduler', 'automatic memory enrollment failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// ── hooks ────────────────────────────────────────────────────────────────────

/** A deleted or rejected memory leaves its source turn and body hash, never its text. */
function writeTombstone({ record, reason }: { record: { ownerUserId: string; scope: { kind: 'user' } | { kind: 'workspace'; workspaceId: string }; body: string; source: { turnId?: string } | null }; reason: 'deleted' | 'rejected' }): void {
  insertExtractionTombstone({
    ownerUserId: record.ownerUserId, workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    sourceTurnId: record.source?.turnId ?? null, bodyHash: memoryBodyHash(record.body), reason, now: Date.now(),
  });
}

function onSettingsChanged(event: MemorySettingsChangedEvent): void {
  if (event.mode === 'auto') {
    const now = Date.now();
    // Conversations from while memory was off or explicit-only are never read (user decision, 2026-11-03).
    if (event.previousMode !== 'auto' && extractionLocalOnly()) {
      restartExtractionAt(event.ownerUserId, (workspaceId) => conversationCompletionCounter(workspaceId), now);
    }
    enrollMemoryExtraction(event.ownerUserId, now);
    attachedScheduler?.wakeJobs([]);
  } else if (event.previousMode === 'auto' && attachedScheduler) {
    cancelMemoryExtraction(event.ownerUserId, attachedScheduler);
  }
}

/** Registers the tombstone hook and the mode listener once; returns an uninstall for tests. */
export function installMemoryExtractionHooks(): () => void {
  const removeHook = onMemoryRemoved(writeTombstone);
  memoryEvents.on('settingsChanged', onSettingsChanged);
  return () => { removeHook(); memoryEvents.off('settingsChanged', onSettingsChanged); };
}

// ── controls ─────────────────────────────────────────────────────────────────

/**
 * Pause stops new executions now; a running one finishes its batch. Resume
 * also restarts consumers the scheduler stopped after repeated failures.
 */
export function setMemoryExtractionPaused(input: {
  ownerUserId: string; workspaceId?: string; paused: boolean; now: number; scheduler: MemoryExtractionScheduler | null;
}): void {
  const states = listExtractionJobStates(input.ownerUserId);
  if (input.workspaceId !== undefined) {
    if (!setExtractionWorkspacePaused(input.workspaceId, input.ownerUserId, input.paused, input.now)) {
      throw new MemoryError('not_found', 'Automatic memory has not started for this workspace');
    }
  } else {
    setExtractionPaused(input.ownerUserId, input.paused, input.now);
  }
  if (input.paused || !input.scheduler) return;
  for (const state of states) {
    if (!state.jobId || !state.autoPaused || (input.workspaceId !== undefined && state.workspaceId !== input.workspaceId)) continue;
    try { input.scheduler.updateJob(state.jobId, { enabled: true }); }
    catch (error) { log.warn('scheduler', 'could not restart automatic memory', { jobId: state.jobId, error: String(error) }); }
  }
  input.scheduler.wakeJobs([]);
}

/** Cancels the owner's running extraction (one workspace's, with workspaceId); it records as cancelled and saves nothing. */
export function cancelMemoryExtraction(ownerUserId: string, scheduler: MemoryExtractionScheduler, workspaceId?: string): number {
  let cancelled = 0;
  for (const state of listExtractionJobStates(ownerUserId)) {
    if (!state.jobId || (workspaceId !== undefined && state.workspaceId !== workspaceId)) continue;
    if (scheduler.cancelActiveRun(state.jobId)) cancelled += 1;
  }
  return cancelled;
}

// ── status (C5) ──────────────────────────────────────────────────────────────

export function memoryExtractionStatus(ownerUserId: string, now: number, scheduler: MemoryExtractionScheduler | null): MemoryExtractionStatus {
  const supported = !!scheduler && extractionLocalOnly();
  const enabled = getMemorySettings(ownerUserId).mode === 'auto';
  const owner = getExtractionState(ownerUserId);
  const jobs = listExtractionJobStates(ownerUserId);
  const runs = listRecentExtractionRuns(ownerUserId, 10);
  const todayTokens = extractionTokensOn(ownerUserId, startOfLocalDay(now));
  const latest = runs.find((run) => run.state !== 'active') ?? null;
  const availability = maintenanceRuntimeAvailability(resolveMetaAgentRuntime(ownerUserId).runtimeId);
  const stopped = jobs.find((job) => job.autoPaused);
  const waiting = jobs.some((job) => !job.paused && !!job.jobId && extractionWorkspace(job.workspaceId, ownerUserId)
    && conversationCompletionCounter(job.workspaceId) > job.completionCursor);
  const exhausted = MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - todayTokens < MEMORY_EXTRACTION_LIMITS.minExecutionBudget;
  let state: MemoryExtractionState;
  let stateReason: string | null = null;
  if (!supported) { state = 'unsupported'; stateReason = UNSUPPORTED_REASON; }
  else if (!enabled) state = 'off';
  else if (!availability.available) { state = 'unsupported'; stateReason = availability.reason ?? 'The Meta agent runtime cannot run automatic memory'; }
  else if (owner.paused) state = 'paused';
  else if (globalMaintenancePaused(ownerUserId)) { state = 'maintenance_paused'; stateReason = 'Meta agent maintenance is paused in Settings › Meta agent'; }
  else if (stopped) { state = 'stopped'; stateReason = stopped.lastError ?? 'Stopped after repeated failed runs; resume to try again'; }
  else if (exhausted) { state = 'budget_exhausted'; stateReason = `Today's automatic memory limit of ${MEMORY_EXTRACTION_LIMITS.dailyTokenLimit} tokens is reached; it continues tomorrow`; }
  else if (liveExtractionRunCount(ownerUserId) > 0) state = 'running';
  else if (waiting) state = 'waiting';
  else state = 'idle';
  return {
    enabled,
    paused: owner.paused,
    lastRunAt: latest ? latest.finishedAt ?? latest.startedAt : null,
    lastError: latest && latest.state !== 'succeeded' ? latest.error : null,
    pendingCount: pendingExtractedMemoryCount(ownerUserId),
    todayTokens,
    dailyTokenLimit: MEMORY_EXTRACTION_LIMITS.dailyTokenLimit,
    executionTokenLimit: MEMORY_EXTRACTION_LIMITS.executionTokenBudget,
    state,
    stateReason,
    supported,
    pausedWorkspaceIds: jobs.filter((job) => job.paused).map((job) => job.workspaceId),
    maybeGlobalMemoryIds: pendingMaybeGlobalMemoryIds(ownerUserId),
    exclusions: [...EXTRACTION_EXCLUSIONS],
    recentRuns: runs.map((run) => {
      // A run left active by a stopped backend shows as failed; its workspace's next run records it so.
      const orphaned = run.state === 'active' && !isExtractionRunLive(run.id);
      return {
        id: run.id, workspaceId: run.workspaceId, state: orphaned ? 'failed' as const : run.state,
        startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary,
        error: orphaned ? 'The run stopped before it finished' : run.error,
        sources: extractionSourceCount(run.id), proposed: run.proposedCount, noChange: run.noChangeCount, dropped: run.droppedCount,
        tokens: run.state === 'active' ? null : run.reportedTokens,
      };
    }),
  };
}
