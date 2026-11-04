import { MaintenanceCoordinator, maintenanceExecutionHasWork, maintenanceCoordinatorState } from '../metaAgent/maintenanceCoordinator';
import { isMemoryExtractionJob } from '../memory/extractionRepository';
import { failMemoryExtractionRun, planMemoryExtractionRun, settleMemoryExtractionRun } from '../memory/extractionRun';
import { sweepMemoryExtraction } from '../memory/extractionService';
import { getScheduledJobSettings } from './settings';
import { randomUUID } from 'node:crypto';
import {
  SCHEDULED_JOB_LIMITS,
  type ScheduledJobDto,
  type ScheduledJobPreviewResponse,
  type ScheduledJobRunDto,
  type ScheduledJobRunEvent,
  type ScheduledJobRunEventPhase,
  type ScheduledJobRunStatus,
  type ScheduledJobRunTrigger,
  type ScheduledJobsSchedulerStatus,
  type ConversationUpdates,
  type MaintenancePlan,
} from 'michi-shared';
import { conversationCompletionCounter, readConversationUpdates } from '../conversationUpdates';
import { getMaintenanceConfig, listMaintenanceBacklog, createMaintenancePlan, claimMaintenancePlan,
  listQueuedMaintenanceRequests, claimQueuedMaintenanceReconsider, claimQueuedMaintenanceCatchup,
  findTerminalMaintenancePlan, claimTerminalMaintenancePlan, maintenancePlanIsTerminal, skipRemovedMaintenanceSources,
  maintenancePlanWaitsOnEditLeases,
} from '../pages/maintenanceRepository';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { resolveMetaAgentRuntime } from '../metaAgent/settings';
import {
  getMetaAgentGuardStatus, metaAgentGuardFailureOf, metaAgentGuardOwnerKey, metaAgentGuardStatusMessage,
  onMetaAgentGuardRetry, recordMetaAgentGuardCheck,
} from '../metaAgent/guardStatus';
import { failHomeRun, planHomeRun, settleHomeRun, sweepMetaAgentHome, type HomeRunPlan } from '../metaAgent/firstRun';
import { failWatchRun, planWatchRun, settleWatchRun, withWorkspaceInstructions, type WatchRunPlan } from '../metaAgent/watches';
import { registerScheduledWorkspacePurge } from './workspacePurge';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { log } from '../logger';
import type { AppLauncher } from './appLauncher';
import type { ScheduledJobEventBus } from './events';
import {
  toJobDto,
  toRunDto,
  type JobUpdate,
  type ScheduledJobRecord,
  type ScheduledJobRunRecord,
  type ScheduledJobsRepository,
  type SchedulerLease,
  type RunAdmissionResult,
} from './repository';
import { computeNextRun, parseSchedule, previewSchedule, ScheduleValidationError, systemTimeZone } from './schedule';
import {
  JobValidationError,
  parseJobCreate,
  parseJobPatch,
  type JobValidationContext,
  type ParsedJobFields,
} from './validation';

export type ScheduledRunOutcomeStatus = 'succeeded' | 'failed' | 'cancelled';

export interface ScheduledRunOutcome {
  status: ScheduledRunOutcomeStatus;
  summary: string | null;
  error: string | null;
  /** Explicit structured acknowledgments, never inferred from the assistant's prose. */
  conversationHandledTurnIds?: string[];
  conversationNoChangeReasons?: Record<string, string>;
}

export interface ScheduledRunHandle {
  nodeId: string;
  treeId: string | null;
  turnId: string | null;
  /** Settles after execution and its pending setup/cleanup have ended. A DB
   * terminal status or cancel acknowledgment is insufficient. Must not reject. */
  done: Promise<ScheduledRunOutcome>;
  cancel(): void;
}

export interface ScheduledRunHooks {
  onAttention(kind: 'approval' | 'input'): void;
  /** Abort pending setup as well as a live turn; executors must recheck after awaits. */
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  conversationBatch?: ConversationUpdates;
  /** Resolved when the run started; replaces the job's own runtime fields for this run. */
  runtimeProfile?: ScheduledRunRuntimeProfile;
  maintenanceContext?: {
    workspaceId: string; ownerUserId: string; jobId: string; runId: string; claimedBy: string;
    configRevision: number; planId: string;
    sources: Array<{ sourceTurnId: string; evidence: { nodeId: string; turnId: string; assistantId: string };
      manifest: Array<{ kind: 'page' | 'database'; id: string; revision: number; pageIds: string[] }> }>;
  };
}

export interface ScheduledRunRuntimeProfile {
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
}

/** Runs one job's prompt. start() rejection must leave no live execution; a
 * returned handle must retain its lifetime in done. Production drives ChatHub. */
export interface ScheduledJobExecutor {
  /** Opt in only if backend process exit proves all work has ended. External
   * agent/provider work does not satisfy this merely because its host exited. */
  readonly processExitStopsExecution?: boolean;
  start(job: ScheduledJobRecord, run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle>;
}

export class ScheduledJobNotFoundError extends Error {}
export class ScheduledJobConflictError extends Error {}
export type ScheduledJobStartRefusal = 'running' | 'capacity' | 'unresolved_execution' | 'lease_lost' | 'stopping' | 'no_work' | 'paused';
export { JobValidationError };

export interface ScheduledJobSchedulerDeps {
  repository: ScheduledJobsRepository;
  executor: ScheduledJobExecutor;
  events: ScheduledJobEventBus;
  workspaceExists(workspaceId: string): boolean;
  runtimeExists(runtimeId: string): boolean;
  launcher?: AppLauncher;
  clock?: () => number;
  instanceId?: string;
  createId?: () => string;
  serviceMode?: boolean;
  pollIntervalMs?: number;
  leaseTtlMs?: number;
  maxConcurrentRuns?: number;
  /** How long a notifier must be gone before the app is woken. */
  notifierGraceMs?: number;
  /** Extra time a cancelled/timed-out turn gets to settle. */
  cancelGraceMs?: number;
}

interface ActiveRun {
  run: ScheduledJobRunRecord;
  lease: SchedulerLease;
  controller: AbortController;
  jobId: string;
  handle: ScheduledRunHandle | null;
  cancelledHandle?: ScheduledRunHandle;
  cancelRequested: boolean;
  timedOut: boolean;
  finalized: boolean;
  executionEnded: boolean;
  conversationBatch?: ConversationUpdates;
  maintenanceConfigRevision?: number;
  maintenancePlan?: MaintenancePlan;
  runtimeProfile?: ScheduledRunRuntimeProfile;
  attentionRequested?: boolean;
  homeRun?: Extract<HomeRunPlan, { id: string }>;
  watchRun?: WatchRunPlan;
  /** A workspace's automatic memory extraction (memory/extractionRun.ts); bound like a watch check. */
  memoryExtraction?: boolean;
  memoryRun?: { id: string; prompt: string };
}

const NOTIFICATION_REPLAY_WINDOW_MS = 24 * 3_600_000;
const MIN_TIMER_DELAY_MS = 1_000;

/**
 * The turns of a claimed plan the feed can still read, without the sources
 * recorded as skipped. Every unfinished source must be among them.
 */
function readablePlanTurns(plan: MaintenancePlan, feed: ConversationUpdates, unreadable: string): ConversationUpdates['turns'] {
  const listed = new Set(plan.sources.filter((source) => source.state !== 'skipped').map((source) => source.sourceTurnId));
  const turns = feed.turns.filter((turn) => listed.has(turn.turnId));
  const read = new Set(turns.map((turn) => turn.turnId));
  const unfinished = plan.sources.filter((source) => source.state !== 'terminal' && source.state !== 'skipped');
  if (unfinished.some((source) => !read.has(source.sourceTurnId)) || turns.some((turn) => turn.contentUnavailable)) {
    throw new Error(unreadable);
  }
  return turns;
}

function summaryOf(record: ScheduledJobRunRecord): ScheduledJobRunDto {
  return toRunDto(record);
}

export class ScheduledJobScheduler {
  private readonly repo: ScheduledJobsRepository;
  private readonly clock: () => number;
  private readonly instanceId: string;
  private readonly createId: () => string;
  private readonly pollIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly notifierGraceMs: number;
  private readonly cancelGraceMs: number;
  private readonly maintenance = new MaintenanceCoordinator();
  private readonly active = new Map<string, ActiveRun>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  private running = false;
  private lease: SchedulerLease | null = null;
  private stopped = false;
  private unregisterWorkspacePurge: (() => void) | null = null;
  private unsubscribeGuardRetry: (() => void) | null = null;

  constructor(private readonly deps: ScheduledJobSchedulerDeps) {
    this.repo = deps.repository;
    this.clock = deps.clock ?? Date.now;
    this.instanceId = deps.instanceId ?? `scheduler-${process.pid}-${randomUUID()}`;
    this.createId = deps.createId ?? (() => `job-${randomUUID()}`);
    this.pollIntervalMs = deps.pollIntervalMs ?? 30_000;
    this.leaseTtlMs = deps.leaseTtlMs ?? 90_000;
    this.maxConcurrentRuns = Math.max(1, Math.floor(deps.maxConcurrentRuns ?? 2));
    this.notifierGraceMs = deps.notifierGraceMs ?? 10_000;
    this.cancelGraceMs = deps.cancelGraceMs ?? 15_000;
  }

  private registerWorkspacePurge(): void {
    if (this.unregisterWorkspacePurge) return;
    this.unregisterWorkspacePurge = registerScheduledWorkspacePurge((workspaceId) => {
      for (const active of this.active.values()) {
        if (active.run.workspaceId !== workspaceId || active.finalized) continue;
        active.cancelRequested = true;
        this.requestCancel(active);
      }
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.registerWorkspacePurge();
    this.unsubscribeGuardRetry ??= onMetaAgentGuardRetry(({ ownerKey, toolsets }) => {
      if (toolsets.includes('maintenance')) this.retryHeldMaintenance(ownerKey);
    });
    this.running = true;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.unregisterWorkspacePurge?.();
    this.unregisterWorkspacePurge = null;
    this.unsubscribeGuardRetry?.();
    this.unsubscribeGuardRetry = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => {});
    for (const active of this.active.values()) {
      this.finalize(active, 'interrupted', null, 'Michi stopped while this run was in progress', this.clock());
      this.requestCancel(active);
      this.repo.quarantineExecution(active.run.id, active.lease, this.clock(), 'Michi stopped before this execution confirmed it ended');
    }
    // Do not release execution reservations here: cancel() is only a request.
    // execute() retains pending starts/handles until their real lifetime ends.
    try { if (this.lease) this.repo.releaseLease(this.lease); } catch { /* database may already be closed */ }
    this.lease = null;
  }

  status(): ScheduledJobsSchedulerStatus {
    return { blockedExecutions: this.repo.blockedExecutions(), active: !!this.lease && this.repo.ownsLease(this.lease, this.clock()), serviceMode: !!this.deps.serviceMode, timezone: systemTimeZone() };
  }

  // ── Job management ──────────────────────────────────────────────────────

  private validationContext(): JobValidationContext {
    return {
      now: this.clock(),
      defaultSessionMode: getScheduledJobSettings().sessionMode,
      workspaceExists: (id) => this.deps.workspaceExists(id),
      runtimeExists: (id) => this.deps.runtimeExists(id),
    };
  }

  now(): number { return this.clock(); }

  /** Reject ordinary job controls for internal maintenance execution identities. */
  requirePromptJob(id: string): void {
    const record = this.repo.getJob(id)?.record;
    if (!record || record.executionKind === 'maintenance') throw new ScheduledJobNotFoundError('Scheduled job not found; open Meta agent maintenance');
  }

  listJobs(): ScheduledJobDto[] {
    return this.repo.listJobs().map(({ record, activeRunId }) => toJobDto(record, activeRunId));
  }

  getJob(id: string): ScheduledJobDto {
    const found = this.repo.getJob(id);
    if (!found) throw new ScheduledJobNotFoundError('Scheduled job not found');
    return toJobDto(found.record, found.activeRunId);
  }

  /**
   * Validate a create request without saving it, returning the normalized
   * fields (defaults applied). Lets a caller show exactly what will be saved
   * before asking the user to approve it.
   */
  validateCreate(raw: unknown): ParsedJobFields {
    const fields = parseJobCreate(raw, this.validationContext());
    if (this.repo.countJobs() >= SCHEDULED_JOB_LIMITS.maxJobs) {
      throw new JobValidationError(`You can have at most ${SCHEDULED_JOB_LIMITS.maxJobs} scheduled jobs`);
    }
    return fields;
  }

  /** Validate an edit without saving it; returns only the fields that change. */
  validateUpdate(id: string, raw: unknown): Partial<ParsedJobFields> {
    const found = this.repo.getJob(id);
    if (!found) throw new ScheduledJobNotFoundError('Scheduled job not found');
    const patch = this.parsePatch(raw, found.record);
    this.validateManagedJobPatch(found.record, patch);
    const current = found.record as unknown as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      const before = key === 'conversationUpdates' ? found.record.conversationCursor != null : current[key];
      if (JSON.stringify(value) !== JSON.stringify(before)) changed[key] = value;
    }
    return changed as Partial<ParsedJobFields>;
  }

  createJob(raw: unknown): ScheduledJobDto {
    return this.createExecution(raw);
  }

  /** Internal ledger entry: no public job, recurring due time or job quota. */
  createMaintenanceExecution(raw: unknown, ownerUserId: string): ScheduledJobDto {
    return this.createExecution(raw, ownerUserId);
  }

  private createExecution(raw: unknown, maintenanceOwner?: string): ScheduledJobDto {
    const fields = maintenanceOwner === undefined ? this.validateCreate(raw) : parseJobCreate(raw, this.validationContext());
    const { conversationUpdates, ...jobFields } = fields;
    const now = this.clock();
    const record: ScheduledJobRecord = {
      id: this.createId(),
      ownerUserId: maintenanceOwner ?? null,
      executionKind: maintenanceOwner === undefined ? 'scheduled' : 'maintenance',
      ...jobFields,
      conversationCursor: conversationUpdates ? conversationCompletionCounter(fields.workspaceId) : null,
      persistentNodeId: null,
      autoPaused: false,
      consecutiveFailures: 0,
      nextRunAt: maintenanceOwner === undefined && fields.enabled ? computeNextRun(fields.schedule, now) : null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertJob(record);
    this.rearm();
    this.publishChange('created', record.id, record.workspaceId);
    return this.getJob(record.id);
  }

  updateJob(id: string, raw: unknown): ScheduledJobDto {
    const found = this.repo.getJob(id);
    if (!found) throw new ScheduledJobNotFoundError('Scheduled job not found');
    const current = found.record;
    const patch = this.parsePatch(raw, current);
    this.validateManagedJobPatch(current, patch);
    const now = this.clock();
    const { conversationUpdates, ...jobPatch } = patch;
    const consumerMoved = patch.workspaceId !== undefined && patch.workspaceId !== current.workspaceId;
    if (found.activeRunId && (current.conversationCursor != null || conversationUpdates === true)
      && (consumerMoved || conversationUpdates !== undefined)) {
      throw new ScheduledJobConflictError('Wait for the running job before changing its conversation consumer');
    }
    const update: JobUpdate = { ...jobPatch, updatedAt: now };
    if (conversationUpdates === false) update.conversationCursor = null;
    else if ((conversationUpdates === true && current.conversationCursor == null)
      || (consumerMoved && current.conversationCursor != null)) {
      update.conversationCursor = conversationCompletionCounter(patch.workspaceId ?? current.workspaceId);
    }

    const scheduleChanged = patch.schedule !== undefined
      && JSON.stringify(patch.schedule) !== JSON.stringify(current.schedule);
    const enabled = patch.enabled ?? current.enabled;
    const resuming = patch.enabled === true && (!current.enabled || current.autoPaused);
    if (resuming) {
      update.autoPaused = false;
      update.consecutiveFailures = 0;
      update.lastError = current.lastStatus === 'succeeded' ? null : current.lastError;
    }
    if (resuming && current.schedule.kind === 'at' && !scheduleChanged && current.schedule.at <= now) {
      throw new JobValidationError('This one-time run already happened. Pick a new time to turn it back on.');
    }
    if (!enabled) {
      update.nextRunAt = null;
    } else if (scheduleChanged || resuming || current.nextRunAt === null) {
      update.nextRunAt = computeNextRun(patch.schedule ?? current.schedule, now);
    }
    // A persistent thread is bound to one workspace and agent profile.
    const profileChanged = (['workspaceId', 'runtimeId', 'providerId', 'modelId', 'reasoning'] as const)
      .some((key) => patch[key] !== undefined && patch[key] !== current[key]);
    if (profileChanged || (patch.sessionMode !== undefined && patch.sessionMode !== current.sessionMode)) {
      update.persistentNodeId = null;
    }
    if (current.executionKind === 'maintenance') update.nextRunAt = null;
    this.repo.updateJob(id, update);
    this.maintenance.wake();
    this.rearm();
    // A moved job disappears from one workspace and appears in another.
    if (patch.workspaceId && patch.workspaceId !== current.workspaceId) {
      this.publishChange('deleted', id, current.workspaceId);
      this.publishChange('created', id, patch.workspaceId);
    } else {
      this.publishChange('updated', id, current.workspaceId);
    }
    return this.getJob(id);
  }

  private publishChange(change: 'created' | 'updated' | 'deleted', jobId: string, workspaceId: string): void {
    this.deps.events.publishChange({ change, jobId, workspaceId, at: this.clock() });
  }

  private parsePatch(raw: unknown, current: ScheduledJobRecord): Partial<ParsedJobFields> {
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    // A one-shot job keeps its (past) time when other fields are edited.
    const sameAt = current.schedule.kind === 'at'
      && body.schedule && typeof body.schedule === 'object'
      && JSON.stringify(body.schedule) === JSON.stringify(current.schedule);
    if (sameAt) {
      const { schedule: _unchanged, ...rest } = body;
      return parseJobPatch(rest, this.validationContext());
    }
    return parseJobPatch(raw, this.validationContext());
  }

  /** Managed maintenance jobs must retain the restricted scheduled-send contract. */
  private validateManagedJobPatch(current: ScheduledJobRecord, patch: Partial<ParsedJobFields>): void {
    const config = getMaintenanceConfig(current.workspaceId, current.ownerUserId ?? LOCAL_AGENT_OWNER_ID);
    if (!config || config.jobId !== current.id) return;

    const allowed = new Set(['enabled', 'runtimeId', 'providerId', 'modelId', 'reasoning', 'schedule']);
    if (Object.keys(patch).some((key) => !allowed.has(key))) {
      throw new JobValidationError('Managed maintenance jobs can only be changed through Space maintenance settings');
    }
    const expectedEnabled = config.enabled && !config.paused;
    if (patch.enabled !== undefined && patch.enabled !== expectedEnabled) {
      throw new JobValidationError('Managed maintenance job state must match Space maintenance settings');
    }
    for (const key of ['runtimeId', 'providerId', 'modelId', 'reasoning'] as const) {
      if (patch[key] !== undefined && patch[key] !== config[key]) {
        throw new JobValidationError('Space maintenance runs on the Meta agent settings; change the runtime there');
      }
    }
    if (patch.schedule !== undefined
      && (patch.schedule.kind !== 'every' || patch.schedule.everySeconds !== 60)) {
      throw new JobValidationError('Managed maintenance schedule is fixed');
    }
  }

  deleteJob(id: string): void {
    const workspaceId = this.repo.getJob(id)?.record.workspaceId ?? null;
    for (const active of this.active.values()) {
      if (active.jobId !== id) continue;
      active.cancelRequested = true;
      this.requestCancel(active);
      active.finalized = true;
      this.repo.quarantineExecution(active.run.id, active.lease, this.clock(), 'The job was deleted before its execution confirmed it stopped');
    }
    if (!this.repo.deleteJob(id)) throw new ScheduledJobNotFoundError('Scheduled job not found');
    this.rearm();
    if (workspaceId) this.publishChange('deleted', id, workspaceId);
  }

  listRuns(jobId: string): ScheduledJobRunDto[] {
    if (!this.repo.getJob(jobId)) throw new ScheduledJobNotFoundError('Scheduled job not found');
    return this.repo.listRuns(jobId).map(summaryOf);
  }

  getRun(runId: string): ScheduledJobRunDto {
    const run = this.repo.getRun(runId);
    if (!run) throw new ScheduledJobNotFoundError('Run not found');
    return summaryOf(run);
  }

  preview(raw: unknown): ScheduledJobPreviewResponse {
    const now = this.clock();
    try {
      const schedule = parseSchedule(raw, now);
      return { valid: true, nextRuns: previewSchedule(schedule, now, 3) };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof ScheduleValidationError ? error.message : 'Invalid schedule',
        nextRuns: [],
      };
    }
  }

  async runNow(jobId: string): Promise<ScheduledJobRunDto> {
    const started = this.startNow(jobId);
    if ('run' in started) return started.run;
    throw new ScheduledJobConflictError(started.message);
  }

  /**
   * runNow without throwing on a refused start, so a caller starting several
   * jobs can tell a full run slot or an already running job from a failure.
   * A missing job or workspace still throws.
   */
  startNow(jobId: string): { run: ScheduledJobRunDto } | { refused: ScheduledJobStartRefusal; message: string; activeRunId: string | null } {
    this.registerWorkspacePurge();
    const found = this.repo.getJob(jobId);
    if (!found) throw new ScheduledJobNotFoundError('Scheduled job not found');
    if (!this.deps.workspaceExists(found.record.workspaceId)) {
      throw new JobValidationError('The workspace for this job is missing or in Trash');
    }
    const refuse = (refused: ScheduledJobStartRefusal, message: string) => ({ refused, message, activeRunId: this.repo.getJob(jobId)?.activeRunId ?? null });
    if (this.stopped) return refuse('stopping', 'The scheduler is stopping');
    const now = this.clock();
    if (found.record.executionKind === 'maintenance') {
      const owner = found.record.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
      if (maintenanceCoordinatorState(owner).paused) return refuse('paused', 'Automatic maintenance is paused');
      if (found.activeRunId) return refuse('running', 'Already updating this workspace');
      if (!maintenanceExecutionHasWork(found.record, now)) return refuse('no_work', 'Already up to date');
    }
    if (!this.acquireOwnership(now)) return refuse('lease_lost', 'Another Michi process owns scheduled execution');
    const result = this.launch(found.record, 'manual', now);
    if (result.run) return { run: summaryOf(result.run) };
    if (result.reason === 'capacity') return refuse('capacity', 'The scheduled job concurrency limit is reached');
    if (result.reason === 'unresolved_execution') return refuse('unresolved_execution', 'A previous scheduled execution has not confirmed it stopped');
    if (result.reason === 'lease_lost') return refuse('lease_lost', 'Scheduler ownership changed; try again after it recovers');
    return refuse('running', 'This job is already running');
  }

  /** Wake the global coordinator. Durable cursors and plans retain the work. */
  wakeJobs(_jobIds: readonly string[]): void {
    this.maintenance.wake();
    if (this.running) void (this.ticking ?? Promise.resolve()).then(() => this.tick(), () => this.tick());
  }


  cancelActiveRun(jobId: string): boolean {
    let cancelled = false;
    for (const active of this.active.values()) {
      if (active.jobId !== jobId || active.finalized) continue;
      active.cancelRequested = true;
      this.requestCancel(active);
      this.repo.quarantineExecution(active.run.id, active.lease, this.clock(), 'Cancellation requested; the execution has not confirmed it stopped');
      cancelled = true;
    }
    return cancelled;
  }

  confirmExecutionStopped(runId: string, raw: unknown): void {
    if (!raw || typeof raw !== 'object' || (raw as { executionStopped?: unknown }).executionStopped !== true) {
      throw new JobValidationError('Confirm that the previous Michi process and its agent execution have stopped');
    }
    const result = this.repo.confirmExecutionStopped(runId);
    if (result === 'missing') throw new ScheduledJobNotFoundError('Execution reservation not found');
    if (result === 'active') throw new ScheduledJobConflictError('The previous Michi process may still start or run this execution. Stop that process and its agent before confirming.');
    this.rearm();
  }

  /** Undelivered desktop notifications, replayed when a notifier connects. */
  pendingNotifications(): ScheduledJobRunEvent[] {
    const since = this.clock() - NOTIFICATION_REPLAY_WINDOW_MS;
    const events: ScheduledJobRunEvent[] = [];
    for (const run of this.repo.pendingNotifications(since)) {
      const job = this.repo.getJob(run.jobId)?.record;
      if (!job) continue;
      const phase: ScheduledJobRunEventPhase = run.notifyKind === 'attention' ? 'attention' : 'finished';
      events.push(this.eventFor(phase, job, run, run.attention ?? undefined));
    }
    return events;
  }

  acknowledgeNotification(runId: string): boolean {
    return this.repo.markNotified(runId);
  }

  // ── Scheduling loop ─────────────────────────────────────────────────────

  /** Exposed for tests; production ticks come from the internal timer. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOnce().finally(() => {
      this.ticking = null;
      this.rearm();
    });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (this.stopped || (!this.running && this.active.size === 0)) return;
    try {
      const now = this.clock();
      for (const active of this.active.values()) if (active.executionEnded) this.releaseEndedExecution(active);
      if (!this.acquireOwnership(now) || !this.running) return;
      sweepMetaAgentHome(this, now);
      sweepMemoryExtraction(this, now);
      for (const job of this.repo.listScheduledJobs()) {
        if (job.nextRunAt === null || job.nextRunAt > now) break;
        if (this.activeCount() >= this.maxConcurrentRuns) break;
        if (!this.deps.workspaceExists(job.workspaceId)) {
          // Keep the schedule moving so a trashed workspace does not spin.
          this.repo.updateJob(job.id, {
            nextRunAt: this.nextAfterScheduledRun(job, now),
            lastError: 'Skipped: the workspace is missing or in Trash',
            updatedAt: now,
          });
          continue;
        }
        const held = this.heldByMetaAgentGuard(job);
        if (held) {
          this.repo.updateJob(job.id, { nextRunAt: this.nextAfterScheduledRun(job, now), lastError: `Skipped: ${held}`, updatedAt: now });
          continue;
        }
        const result = this.launch(job, 'scheduled', now);
        if (!result.run && (result.reason === 'capacity' || result.reason === 'unresolved_execution' || result.reason === 'lease_lost')) break;
        if (!result.run) {
          // Still running (overlap) or claimed elsewhere: skip this occurrence.
          this.repo.updateJob(job.id, { nextRunAt: this.nextAfterScheduledRun(job, now), updatedAt: now });
        }
      }
      this.maintenance.check(now, this.repo.listMaintenanceExecutions(), (record) => {
        if (this.activeCount() >= this.maxConcurrentRuns || this.heldByMetaAgentGuard(record)
          || !maintenanceRuntimeAvailability(resolveMetaAgentRuntime(record.ownerUserId ?? LOCAL_AGENT_OWNER_ID).runtimeId).available) return false;
        return !!this.launch(record, 'scheduled', now).run;
      });
    } catch (error) {
      log.warn('scheduler', 'tick failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private rearm(): void {
    if (this.stopped || (!this.running && this.active.size === 0)) return;
    if (this.timer) clearTimeout(this.timer);
    let delay = Math.min(this.pollIntervalMs, 60_000, Math.max(1, Math.floor(this.leaseTtlMs / 3)));
    try {
      if (this.running && this.lease && this.activeCount() < this.maxConcurrentRuns) {
        const next = this.repo.listScheduledJobs()[0]?.nextRunAt ?? null;
        if (next !== null) delay = Math.min(delay, Math.max(MIN_TIMER_DELAY_MS, next - this.clock()));
      }
    } catch {
      // Keep the poll cadence if the database is busy.
    }
    this.timer = setTimeout(() => { void this.tick(); }, delay);
    this.timer.unref?.();
  }

  private activeCount(): number {
    return this.active.size;
  }

  private acquireOwnership(now: number): boolean {
    const lease = this.repo.acquireLease(this.instanceId, now, this.leaseTtlMs);
    if (!lease || (this.lease && this.lease.generation !== lease.generation)) {
      for (const active of this.active.values()) this.loseOwnership(active, now);
    }
    this.lease = lease;
    if (!lease) return false;
    const interrupted = this.repo.interruptStaleRuns(lease, now);
    if (interrupted > 0) log.warn('scheduler', 'fenced runs from previous scheduler ownership', { interrupted });
    this.repo.reapExitedExecutions(lease, now);
    return true;
  }

  private requestCancel(active: ActiveRun): void {
    active.controller.abort();
    if (active.handle && active.cancelledHandle !== active.handle) {
      active.cancelledHandle = active.handle;
      try { active.handle.cancel(); } catch { /* reservation remains until done settles */ }
    }
  }

  private loseOwnership(active: ActiveRun, now: number): void {
    active.finalized = true;
    this.requestCancel(active);
    try { this.repo.interruptExecution(active.run.id, active.lease, now); }
    catch (error) { log.warn('scheduler', 'could not fence lost execution', { runId: active.run.id, error: String(error) }); }
  }

  private nextAfterScheduledRun(job: ScheduledJobRecord, now: number): number | null {
    return computeNextRun(job.schedule, now);
  }

  /** A failed maintenance check on the profile a run would use now holds scheduled maintenance runs. */
  private heldByMetaAgentGuard(job: ScheduledJobRecord): string | null {
    const owner = job.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
    if (getMaintenanceConfig(job.workspaceId, owner)?.jobId !== job.id) return null;
    const status = getMetaAgentGuardStatus('maintenance', () => resolveMetaAgentRuntime(owner), owner);
    return status?.state === 'failed' ? metaAgentGuardStatusMessage(status) : null;
  }

  /** After a retry one managed maintenance run starts now; the others follow their schedule. */
  private retryHeldMaintenance(ownerKey: string): void {
    try {
      const job = this.repo.listMaintenanceExecutions().find((candidate) => {
        const owner = candidate.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
        return metaAgentGuardOwnerKey(owner) === ownerKey && getMaintenanceConfig(candidate.workspaceId, owner)?.jobId === candidate.id;
      });
      if (!job) return;
      this.startNow(job.id);
      this.maintenance.wake();
    } catch (error) {
      log.warn('scheduler', 'could not start maintenance after a Meta agent retry', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** `error` null: the run's turn succeeded, so it passed its check. Other errors leave the stored check as it is. */
  private recordMetaAgentCheck(job: ScheduledJobRecord, active: ActiveRun, error: unknown | null): void {
    // Automatic memory checks a different closed toolset; its result says nothing about Pages maintenance's.
    if (!active.runtimeProfile || active.memoryExtraction) return;
    const failure = error === null ? null : metaAgentGuardFailureOf(error);
    if (error !== null && !failure) return;
    try {
      recordMetaAgentGuardCheck({ toolset: 'maintenance', profile: active.runtimeProfile, failure,
        ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, now: this.clock() });
    } catch (dbError) {
      log.warn('scheduler', 'could not record the Meta agent check', { runId: active.run.id, error: String(dbError) });
    }
  }

  private launch(job: ScheduledJobRecord, trigger: ScheduledJobRunTrigger, now: number): RunAdmissionResult {
    if (!this.lease) return { run: null, reason: 'lease_lost' };
    const result = this.repo.claimRun({
      jobId: job.id,
      runId: `run-${randomUUID()}`,
      trigger, now,
      lease: this.lease,
      maxConcurrentRuns: this.maxConcurrentRuns,
      processExitStopsExecution: this.deps.executor.processExitStopsExecution === true,
      nextRunAt: job.executionKind === 'maintenance' ? null : trigger === 'scheduled' ? this.nextAfterScheduledRun(job, now) : undefined,
      requireDue: job.executionKind !== 'maintenance' && trigger === 'scheduled',
    });
    if (!result.run) return result;
    const active: ActiveRun = {
      run: result.run, lease: this.lease, controller: new AbortController(),
      jobId: job.id, handle: null, cancelRequested: false, timedOut: false, finalized: false, executionEnded: false,
    };
    this.active.set(result.run.id, active);
    void this.execute(job, active);
    this.rearm();
    return result;
  }

  private async execute(job: ScheduledJobRecord, active: ActiveRun): Promise<void> {
    const { run } = active;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let lifetime: Promise<ScheduledRunOutcome> | null = null;
    try {
      timeoutTimer = setTimeout(() => {
        if (active.finalized) return;
        active.timedOut = true;
        this.requestCancel(active);
        this.repo.quarantineExecution(run.id, active.lease, this.clock(), 'Timed out; the execution has not confirmed it stopped');
        graceTimer = setTimeout(() => {
          this.finalize(active, 'timed_out', null, `Timed out after ${Math.round(job.timeoutSeconds / 60)} min`, this.clock());
        }, this.cancelGraceMs);
        graceTimer.unref?.();
      }, job.timeoutSeconds * 1000);
      timeoutTimer.unref?.();
      const config = getMaintenanceConfig(job.workspaceId, job.ownerUserId ?? LOCAL_AGENT_OWNER_ID);
      const managedMaintenance = config?.jobId === job.id ? config : null;
      if (managedMaintenance && (job.conversationCursor == null || job.sessionMode !== 'fresh' || job.permissionMode !== 'trust'
        || job.notify || job.runtimeId !== managedMaintenance.runtimeId || job.providerId !== managedMaintenance.providerId
        || job.modelId !== managedMaintenance.modelId || job.reasoning !== managedMaintenance.reasoning
        || job.schedule.kind !== 'every' || job.schedule.everySeconds !== 60
        || job.enabled !== (managedMaintenance.enabled && !managedMaintenance.paused))) {
        throw new Error('Managed maintenance job no longer matches its restricted configuration');
      }
      if (managedMaintenance && (!managedMaintenance.enabled || managedMaintenance.paused)) {
        throw new Error('Workspace maintenance is paused');
      }
      if (!managedMaintenance && job.executionKind === 'maintenance' && isMemoryExtractionJob(job.id)) {
        active.memoryExtraction = true;
        const ownerUserId = job.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
        // Resolved once per run, like maintenance: the Meta agent's runtime, model and credentials.
        const { followsGlobal: _followsGlobal, ...profile } = resolveMetaAgentRuntime(ownerUserId);
        const availability = maintenanceRuntimeAvailability(profile.runtimeId);
        if (!availability.available) throw new Error(availability.reason ?? `Runtime "${profile.runtimeId}" is unavailable for automatic memory`);
        const plan = planMemoryExtractionRun({ jobId: job.id, workspaceId: job.workspaceId, ownerUserId, runId: run.id, now: this.clock() });
        if (plan.kind === 'skip') {
          // Nothing to read, or held since discovery: no session, no model call, not a failure.
          this.finalize(active, 'succeeded', plan.summary, null, this.clock());
          return;
        }
        active.memoryRun = { id: plan.id, prompt: plan.prompt };
        active.runtimeProfile = profile;
        active.maintenanceConfigRevision = plan.configRevision;
      }
      if (managedMaintenance) {
        const plan = planHomeRun({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID,
          jobId: job.id, runId: run.id, now: this.clock() });
        if (plan?.kind === 'refuse') throw new Error(plan.error);
        if (plan) active.homeRun = plan;
        // A due watch check runs before conversation work; its interval counts from this start.
        else active.watchRun = planWatchRun({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID,
          jobId: job.id, runId: run.id, now: this.clock() }) ?? undefined;
      }
      if (managedMaintenance) {
        // Resolved once per run: a settings change applies from the next run, never to this one.
        const { followsGlobal: _followsGlobal, ...profile } = resolveMetaAgentRuntime(job.ownerUserId ?? LOCAL_AGENT_OWNER_ID);
        const availability = maintenanceRuntimeAvailability(profile.runtimeId);
        if (!availability.available) throw new Error(availability.reason ?? `Runtime "${profile.runtimeId}" is unavailable for maintenance`);
        active.runtimeProfile = profile;
        active.maintenanceConfigRevision = managedMaintenance.revision;
      }
      const cursor = active.homeRun || active.watchRun ? null : managedMaintenance?.completionCursor ?? job.conversationCursor;
      if (cursor != null) {
        const ownerUserId = job.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
        if (managedMaintenance) {
          const currentCounter = conversationCompletionCounter(job.workspaceId);
          const completed = findTerminalMaintenancePlan({ workspaceId: job.workspaceId, ownerUserId, jobId: job.id,
            after: cursor, through: currentCounter });
          if (completed) {
            const authority = { workspaceId: job.workspaceId, ownerUserId, jobId: job.id, runId: active.run.id,
              claimedBy: this.instanceId, configRevision: managedMaintenance.revision };
            active.maintenancePlan = claimTerminalMaintenancePlan({ ...authority, planId: completed.id, now: this.clock() });
            active.maintenanceConfigRevision = managedMaintenance.revision;
            active.conversationBatch = { after: cursor, through: completed.through, totalTurns: completed.sources.length,
              byNode: [], turns: [], nextAfter: completed.through, hasMore: false };
            this.finalize(active, 'succeeded', 'Recovered completed maintenance plan', null, this.clock(), true);
            return;
          }
        }
        const queued = managedMaintenance ? listQueuedMaintenanceRequests(job.workspaceId, ownerUserId)[0] : undefined;
        const backlog = managedMaintenance ? listMaintenanceBacklog(job.workspaceId, ownerUserId) : null;
        const pending = !queued ? backlog?.plans.find((plan) => plan.state === 'routing' || plan.state === 'processing') : undefined;
        let page: ConversationUpdates;
        if ((queued || pending) && managedMaintenance) {
          const authority = { workspaceId: job.workspaceId, ownerUserId, jobId: job.id, runId: active.run.id,
            claimedBy: this.instanceId, configRevision: managedMaintenance.revision };
          const claimed = queued
            ? queued.kind === 'reconsider'
              ? claimQueuedMaintenanceReconsider({ ...authority, requestId: queued.requestId, now: this.clock() })
              : claimQueuedMaintenanceCatchup({ ...authority, requestId: queued.requestId, now: this.clock() })
            : claimMaintenancePlan({ ...authority, planId: pending!.id, now: this.clock() });
          active.maintenanceConfigRevision = managedMaintenance.revision;
          const plan = active.maintenancePlan = skipRemovedMaintenanceSources({ ...authority, planId: claimed.id, now: this.clock() });
          const feed = readConversationUpdates({ workspaceId: job.workspaceId, ownerUserId, backendConnectionId: 'local' },
            // The maintenance reader fetches source messages from durable descriptors, including oversized turns.
            { after: plan.after, through: plan.through, includeMessages: false, limit: 100 });
          const turns = readablePlanTurns(plan, feed, queued
            ? 'A reconsidered conversation source is no longer readable; progress retained'
            : 'A pending maintenance source is no longer readable; progress retained');
          page = { ...feed, after: cursor, through: cursor, totalTurns: turns.length, turns,
            nextAfter: cursor, hasMore: false };
          if (maintenancePlanIsTerminal(plan.id, ownerUserId)) {
            // Every source left was removed by the user: the batch completes without a session.
            const nextAfter = plan.after === cursor && !plan.reconsiderOfPlanId ? plan.through : cursor;
            active.conversationBatch = { ...page, through: nextAfter, totalTurns: 0, turns: [], nextAfter };
            this.finalize(active, 'succeeded', 'Skipped conversations that were deleted or archived', null, this.clock(), true);
            return;
          }
        } else {
          page = readConversationUpdates({ workspaceId: job.workspaceId,
            ownerUserId, backendConnectionId: 'local' }, { after: cursor, includeMessages: !managedMaintenance });
        }
        active.conversationBatch = page;
        if (!page.turns.length) {
          if (managedMaintenance && !active.maintenancePlan && page.nextAfter > cursor) {
            active.maintenancePlan = createMaintenancePlan({ workspaceId: job.workspaceId,
              ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, jobId: job.id, runId: active.run.id,
              claimedBy: this.instanceId, configRevision: managedMaintenance.revision,
              after: cursor, through: page.nextAfter, now: this.clock() });
          }
          this.finalize(active, 'succeeded', 'No new conversation turns', null, this.clock(), true);
          return;
        }
        if (!managedMaintenance && page.turns.some(turn => turn.contentTooLarge || turn.contentUnavailable)) {
          throw new Error(`Conversation input ${page.turns[0].turnId} is too large or unavailable; progress retained`);
        }
        if (managedMaintenance && !active.maintenancePlan && page.turns.length) {
          const authority = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, jobId: job.id,
            runId: active.run.id, claimedBy: this.instanceId, configRevision: managedMaintenance.revision };
          active.maintenancePlan = createMaintenancePlan({ ...authority, after: page.after, through: page.nextAfter, now: this.clock() });
        }
      }
      const homeRun = active.homeRun;
      const watchRun = active.watchRun;
      const ownerUserId = job.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
      // The workspace's instructions join every run that writes this workspace; the Spaces Home summary spans all of them.
      const memoryRun = active.memoryRun;
      const prompt = memoryRun ? memoryRun.prompt : watchRun ? watchRun.prompt
        : homeRun?.kind === 'home-summary' ? homeRun.prompt
          : managedMaintenance ? withWorkspaceInstructions(homeRun?.prompt ?? job.prompt, job.workspaceId, ownerUserId)
            : job.prompt;
      const boundRun = homeRun ?? watchRun ?? memoryRun;
      const handle = await this.deps.executor.start(prompt === job.prompt ? job : { ...job, prompt }, run, {
        onAttention: (kind) => this.onAttention(job, active, kind),
        signal: active.controller.signal,
        isCurrent: () => !active.finalized && !active.controller.signal.aborted
          && this.repo.ownsRun(run.id, active.lease, this.clock()),
        conversationBatch: active.conversationBatch,
        ...(active.runtimeProfile ? { runtimeProfile: active.runtimeProfile } : {}),
        ...(boundRun && active.maintenanceConfigRevision !== undefined ? { maintenanceContext: {
          workspaceId: job.workspaceId, ownerUserId, jobId: job.id,
          runId: run.id, claimedBy: this.instanceId, configRevision: active.maintenanceConfigRevision,
          planId: boundRun.id, sources: [],
        } } : {}),
        ...(!boundRun && active.maintenancePlan && active.maintenanceConfigRevision !== undefined ? { maintenanceContext: {
          workspaceId: job.workspaceId, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, jobId: job.id,
          runId: run.id, claimedBy: this.instanceId, configRevision: active.maintenanceConfigRevision,
          planId: active.maintenancePlan.id,
          sources: active.maintenancePlan.sources.filter((source) => source.state !== 'skipped')
            .map((source) => ({ sourceTurnId: source.sourceTurnId, evidence: source.evidence, manifest: [] })),
        } } : {}),
      });
      active.handle = handle;
      const done = lifetime = handle.done.catch((error: unknown): ScheduledRunOutcome => ({
        status: 'failed', summary: null, error: error instanceof Error ? error.message : String(error),
      }));
      if (!active.finalized && !this.repo.ownsRun(run.id, active.lease, this.clock())) this.loseOwnership(active, this.clock());
      if (active.finalized || active.controller.signal.aborted) {
        this.requestCancel(active);
      } else {
        const target = { nodeId: handle.nodeId, treeId: handle.treeId, turnId: handle.turnId };
        const attached = this.repo.attachRunTarget(run.id, target, active.lease, this.clock(),
          job.sessionMode === 'persistent' ? handle.nodeId : undefined);
        if (!attached) this.loseOwnership(active, this.clock());
        else {
          active.run = { ...run, ...target };
          if (this.repo.ownsLease(active.lease, this.clock())) this.publish('started', job, active.run);
          else this.loseOwnership(active, this.clock());
        }
      }
      // Even after timeout, deletion, shutdown or ownership loss we await the
      // actual handle. A requested cancellation never releases admission.
      const outcome = await done;
      if (outcome.status !== 'cancelled') this.recordMetaAgentCheck(job, active, outcome.status === 'succeeded' ? null : outcome.error);
      if (active.finalized) return;
      let status: ScheduledJobRunStatus = active.timedOut ? 'timed_out'
        : active.cancelRequested ? 'cancelled' : outcome.status === 'cancelled' ? 'failed' : outcome.status;
      let error = status === 'timed_out' ? `Timed out after ${Math.round(job.timeoutSeconds / 60)} min`
        : status === 'cancelled' ? 'Cancelled'
          : status === 'failed' ? outcome.error ?? 'The agent stopped before finishing' : null;
      let summary = outcome.summary;
      if (active.homeRun) {
        const settled = settleHomeRun({ id: active.homeRun.id, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID,
          status, error, turnId: handle.turnId, now: this.clock() });
        status = settled.status;
        error = settled.error;
        summary = settled.summary ?? summary;
      }
      if (active.watchRun) {
        const settled = settleWatchRun({ id: active.watchRun.id, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID,
          status, error, turnId: handle.turnId, now: this.clock() });
        status = settled.status;
        error = settled.error;
        summary = settled.summary ?? summary;
      }
      if (active.memoryRun) {
        // Commits the staged candidates and the cursor only with every receipt; the reply never settles it.
        const settled = settleMemoryExtractionRun({ id: active.memoryRun.id, ownerUserId: job.ownerUserId ?? LOCAL_AGENT_OWNER_ID,
          status, error, turnId: handle.turnId, claimedBy: this.instanceId, now: this.clock() });
        status = settled.status;
        error = settled.error;
        summary = settled.summary ?? summary;
      }
      const page = active.conversationBatch;
      let consumed = false;
      if (page && status === 'succeeded') {
        if (active.maintenancePlan && active.maintenanceConfigRevision !== undefined) {
          const ownerUserId = job.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
          consumed = !active.attentionRequested && maintenancePlanIsTerminal(active.maintenancePlan.id, ownerUserId);
          // Pages left for conversations editing them are not a failure: the plan resumes after their turns end.
          const deferred = !consumed && !active.attentionRequested
            ? maintenancePlanWaitsOnEditLeases(active.maintenancePlan.id, ownerUserId, this.clock(), active.run.id) : null;
          if (deferred?.waiting) {
            summary = `Waiting for a conversation to finish editing ${deferred.pages === 1 ? '1 page' : `${deferred.pages} pages`}; progress retained`;
          } else if (!consumed) { status = 'failed'; error = 'Maintenance plan has unfinished source decisions; progress retained'; }
        } else {
          const handled = new Set(outcome.conversationHandledTurnIds ?? []);
          consumed = !active.attentionRequested && handled.size === page.turns.length && page.turns.every(turn => handled.has(turn.turnId));
          if (!consumed) { status = 'failed'; error = 'Conversation batch was not fully confirmed; progress retained'; }
        }
      }
      this.finalize(active, status, summary, error, this.clock(), consumed);
    } catch (error) {
      if (active.handle) {
        this.requestCancel(active);
        this.repo.quarantineExecution(run.id, active.lease, this.clock(), 'Run setup failed; the execution has not confirmed it stopped');
      }
      const message = error instanceof Error ? error.message : String(error);
      this.recordMetaAgentCheck(job, active, error ?? message);
      if (active.homeRun) failHomeRun(active.homeRun.id, job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, message, this.clock(), error);
      if (active.watchRun) failWatchRun(active.watchRun.id, job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, message, this.clock());
      if (active.memoryRun) failMemoryExtractionRun(active.memoryRun.id, job.ownerUserId ?? LOCAL_AGENT_OWNER_ID, message, this.clock(), active.cancelRequested);
      if (!active.finalized) {
        log.warn('scheduler', 'scheduled run could not start', { jobId: job.id, runId: run.id, error: message });
        const status = active.timedOut ? 'timed_out' : active.cancelRequested ? 'cancelled' : 'failed';
        this.finalize(active, status, null, message, this.clock());
      }
    } finally {
      if (lifetime) await lifetime;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      // start() must reject only after it has cleaned up any executor it created.
      // A returned handle must keep done pending until real execution ends.
      active.executionEnded = true;
      this.releaseEndedExecution(active);
      this.rearm();
    }
  }

  private releaseEndedExecution(active: ActiveRun): void {
    this.maintenance.wake();
    try {
      this.repo.releaseExecution(active.run.id, active.lease);
      this.active.delete(active.run.id);
    } catch (error) {
      log.warn('scheduler', 'could not release execution reservation', { runId: active.run.id, error: String(error) });
      try { this.repo.quarantineExecution(active.run.id, active.lease, this.clock(), 'Execution ended but its reservation could not be cleared; waiting for scheduler recovery'); }
      catch { /* Retain the in-memory end acknowledgment and retry next tick. */ }
    }
  }

  private onAttention(job: ScheduledJobRecord, active: ActiveRun, kind: 'approval' | 'input'): void {
    if (active.finalized) return;
    active.attentionRequested = true;
    try {
      if (!this.repo.markAttention(active.run.id, kind, active.lease, this.clock())) {
        this.loseOwnership(active, this.clock());
        return;
      }
    } catch {
      return;
    }
    if (!this.repo.ownsLease(active.lease, this.clock())) { this.loseOwnership(active, this.clock()); return; }
    this.publish('attention', job, active.run, kind);
    this.maybeWakeApp();
  }

  private finalize(
    active: ActiveRun,
    status: Exclude<ScheduledJobRunStatus, 'running'>,
    summary: string | null,
    error: string | null,
    now: number,
    consumed = false,
  ): void {
    if (active.finalized) return;
    if (!this.repo.ownsRun(active.run.id, active.lease, now)) {
      this.loseOwnership(active, now);
      return;
    }
    active.finalized = true;
    let job: ScheduledJobRecord | null = null;
    let finished = false;
    try {
      job = this.repo.getJob(active.jobId)?.record ?? null;
      const notify = !!job?.notify && (status === 'succeeded' || status === 'failed' || status === 'timed_out')
        && !(consumed && active.conversationBatch?.totalTurns === 0);
      finished = this.repo.finishRun(active.run.id, active.lease, { status, finishedAt: now, summary, error, notify,
        ...(consumed && active.conversationBatch ? { conversationProgress: {
          after: active.conversationBatch.after, nextAfter: active.conversationBatch.nextAfter,
          workspaceId: active.run.workspaceId, claimedBy: this.instanceId,
          ...(active.maintenanceConfigRevision !== undefined ? { maintenanceConfigRevision: active.maintenanceConfigRevision,
            maintenancePlanId: active.maintenancePlan?.id ?? null,
            maintenanceOwnerUserId: job?.ownerUserId ?? LOCAL_AGENT_OWNER_ID } : {}),
        } } : {}),
      });
      const stored = this.repo.getRun(active.run.id);
      if (stored) { status = stored.status as Exclude<ScheduledJobRunStatus, 'running'>; error = stored.error; }
    } catch (dbError) {
      log.warn('scheduler', 'could not record run result', { runId: active.run.id, error: (dbError as Error).message });
      return;
    }
    if (!finished || !job) return;

    const failed = status === 'failed' || status === 'timed_out';
    const failures = status === 'succeeded' ? 0 : failed ? job.consecutiveFailures + 1 : job.consecutiveFailures;
    const pauseNow = failed && !job.autoPaused && failures >= SCHEDULED_JOB_LIMITS.autoPauseThreshold;
    const update: JobUpdate = {
      lastStatus: status,
      lastError: status === 'succeeded' ? null : error,
      consecutiveFailures: failures,
      updatedAt: now,
    };
    if (pauseNow) {
      update.autoPaused = true;
      update.lastError = `${error ?? 'Run failed'}. Paused after ${failures} failed runs in a row.`;
    }
    if (job.schedule.kind === 'at' && active.run.trigger === 'scheduled') {
      update.enabled = false;
      update.nextRunAt = null;
    }
    try {
      if (!this.repo.updateFinishedJob(active.run.id, active.lease, now, update)) return;
      this.repo.pruneRuns(job.id);
    } catch (dbError) {
      log.warn('scheduler', 'could not update job after run', { jobId: job.id, error: (dbError as Error).message });
    }
    const latestRun = this.repo.getRun(active.run.id) ?? { ...active.run, status, finishedAt: now, summary, error };
    if (!this.repo.ownsLease(active.lease, this.clock())) return;
    this.publish('finished', { ...job, notify: job.notify && !(consumed && active.conversationBatch?.totalTurns === 0) }, latestRun);
    if (job.notify && status !== 'interrupted' && status !== 'cancelled'
      && !(consumed && active.conversationBatch?.totalTurns === 0)) this.maybeWakeApp();
    this.rearm();
  }

  private maybeWakeApp(): void {
    if (!this.deps.launcher) return;
    if (this.deps.events.hasNotifier()) return;
    if (this.deps.events.notifierAbsentForMs() < this.notifierGraceMs) return;
    this.deps.launcher.wake();
  }

  private eventFor(
    phase: ScheduledJobRunEventPhase,
    job: ScheduledJobRecord,
    run: ScheduledJobRunRecord,
    attention?: 'approval' | 'input',
  ): ScheduledJobRunEvent {
    return {
      phase,
      runId: run.id,
      jobId: job.id,
      jobName: job.name,
      workspaceId: run.workspaceId,
      nodeId: run.nodeId,
      treeId: run.treeId,
      status: run.status,
      summary: run.summary,
      error: run.error,
      notify: job.notify,
      ...(attention ? { attention } : {}),
      at: run.finishedAt ?? this.clock(),
    };
  }

  private publish(
    phase: ScheduledJobRunEventPhase,
    job: ScheduledJobRecord,
    run: ScheduledJobRunRecord,
    attention?: 'approval' | 'input',
  ): void {
    this.deps.events.publish(this.eventFor(phase, job, run, attention));
  }
}
