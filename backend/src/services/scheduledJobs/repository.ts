import {
  SCHEDULED_JOB_LIMITS,
  isChatPermissionMode,
  isScheduledJobRunStatus,
  type ChatPermissionMode,
  type ScheduledJobDto,
  type ScheduledJobRunDto,
  type ScheduledJobBlockedExecution,
  type ScheduledJobRunStatus,
  type ScheduledJobRunTrigger,
  type ScheduledJobSchedule,
  type ScheduledJobSessionMode,
} from 'michi-shared';
import { getDb, runInTransaction } from '../db';

interface JobRow {
  execution_kind: 'scheduled' | 'maintenance';
  id: string;
  owner_user_id: string | null;
  workspace_id: string;
  name: string;
  prompt: string;
  schedule: string;
  runtime_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  reasoning: string | null;
  permission_mode: string;
  session_mode: string;
  persistent_node_id: string | null;
  notify: number;
  enabled: number;
  auto_paused: number;
  consecutive_failures: number;
  timeout_seconds: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  active_run_id?: string | null;
  conversation_cursor: number | null;
}

interface RunRow {
  id: string;
  job_id: string;
  workspace_id: string;
  node_id: string | null;
  tree_id: string | null;
  turn_id: string | null;
  trigger: string;
  status: string;
  scheduled_for: number | null;
  started_at: number;
  finished_at: number | null;
  summary: string | null;
  error: string | null;
  notify_state: string;
  notify_kind: string | null;
  attention: string | null;
  claimed_by: string;
}

/** Everything the scheduler needs to persist about a job. */
export interface ScheduledJobRecord {
  /** Maintenance uses this ledger for fenced execution and historical receipts, never its schedule. */
  executionKind?: 'scheduled' | 'maintenance';
  conversationCursor?: number | null;
  id: string;
  ownerUserId: string | null;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduledJobSchedule;
  runtimeId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: ChatPermissionMode;
  sessionMode: ScheduledJobSessionMode;
  persistentNodeId: string | null;
  notify: boolean;
  enabled: boolean;
  autoPaused: boolean;
  consecutiveFailures: number;
  timeoutSeconds: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduledJobRunStatus | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledJobRunRecord extends ScheduledJobRunDto {
  turnId: string | null;
  notifyState: 'none' | 'pending' | 'delivered';
  notifyKind: 'finished' | 'attention' | null;
  attention: 'approval' | 'input' | null;
  claimedBy: string;
}

const JOB_COLUMNS = `j.*, (SELECT r.id FROM scheduled_job_runs r WHERE r.job_id = j.id AND r.status = 'running' ORDER BY r.started_at DESC LIMIT 1) AS active_run_id`;

function parseScheduleColumn(raw: string): ScheduledJobSchedule {
  const value = JSON.parse(raw) as ScheduledJobSchedule;
  return value;
}

function toRecord(row: JobRow): ScheduledJobRecord {
  return {
    id: row.id,
    executionKind: row.execution_kind,
    conversationCursor: row.conversation_cursor ?? null,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    name: row.name,
    prompt: row.prompt,
    schedule: parseScheduleColumn(row.schedule),
    runtimeId: row.runtime_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoning: row.reasoning,
    permissionMode: isChatPermissionMode(row.permission_mode) ? row.permission_mode : 'ask',
    sessionMode: row.session_mode === 'persistent' ? 'persistent' : 'fresh',
    persistentNodeId: row.persistent_node_id,
    notify: row.notify === 1,
    enabled: row.enabled === 1,
    autoPaused: row.auto_paused === 1,
    consecutiveFailures: row.consecutive_failures,
    timeoutSeconds: row.timeout_seconds,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: isScheduledJobRunStatus(row.last_status) ? row.last_status : null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toJobDto(record: ScheduledJobRecord, activeRunId: string | null): ScheduledJobDto {
  return {
    id: record.id,
    conversationCursor: record.conversationCursor ?? null,
    workspaceId: record.workspaceId,
    name: record.name,
    prompt: record.prompt,
    schedule: record.schedule,
    runtimeId: record.runtimeId,
    providerId: record.providerId,
    modelId: record.modelId,
    reasoning: record.reasoning,
    permissionMode: record.permissionMode,
    sessionMode: record.sessionMode,
    notify: record.notify,
    enabled: record.enabled,
    autoPaused: record.autoPaused,
    timeoutSeconds: record.timeoutSeconds,
    nextRunAt: record.enabled && !record.autoPaused ? record.nextRunAt : null,
    lastRunAt: record.lastRunAt,
    lastStatus: record.lastStatus,
    lastError: record.lastError,
    consecutiveFailures: record.consecutiveFailures,
    activeRunId,
    persistentNodeId: record.persistentNodeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toRunRecord(row: RunRow): ScheduledJobRunRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    treeId: row.tree_id,
    turnId: row.turn_id,
    trigger: row.trigger === 'manual' ? 'manual' : 'scheduled',
    status: isScheduledJobRunStatus(row.status) ? row.status : 'failed',
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    error: row.error,
    notifyState: row.notify_state === 'pending' || row.notify_state === 'delivered' ? row.notify_state : 'none',
    notifyKind: row.notify_kind === 'finished' || row.notify_kind === 'attention' ? row.notify_kind : null,
    attention: row.attention === 'approval' || row.attention === 'input' ? row.attention : null,
    claimedBy: row.claimed_by,
  };
}

export function toRunDto(record: ScheduledJobRunRecord): ScheduledJobRunDto {
  return {
    id: record.id,
    jobId: record.jobId,
    workspaceId: record.workspaceId,
    nodeId: record.nodeId,
    treeId: record.treeId,
    trigger: record.trigger,
    status: record.status,
    scheduledFor: record.scheduledFor,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    summary: record.summary,
    error: record.error,
  };
}

export interface SchedulerLease {
  holder: string;
  generation: number;
}

export type RunAdmissionResult =
  | { run: ScheduledJobRunRecord; reason?: never }
  | { run: null; reason: 'missing' | 'not_due' | 'job_running' | 'capacity' | 'lease_lost' | 'unresolved_execution' };

export interface ClaimRunInput {
  jobId: string;
  runId: string;
  trigger: ScheduledJobRunTrigger;
  now: number;
  lease: SchedulerLease;
  maxConcurrentRuns: number;
  processExitStopsExecution: boolean;
  /** Next due time to store for the job; undefined leaves it unchanged. */
  nextRunAt?: number | null;
  /** Scheduled runs only claim a job that is still due. */
  requireDue: boolean;
}

export type JobUpdate = Partial<Omit<ScheduledJobRecord, 'id' | 'ownerUserId' | 'workspaceId' | 'createdAt'>> & {
  workspaceId?: string;
};

const UPDATE_COLUMNS: Record<keyof JobUpdate, string> = {
  executionKind: 'execution_kind',
  conversationCursor: 'conversation_cursor',
  workspaceId: 'workspace_id',
  name: 'name',
  prompt: 'prompt',
  schedule: 'schedule',
  runtimeId: 'runtime_id',
  providerId: 'provider_id',
  modelId: 'model_id',
  reasoning: 'reasoning',
  permissionMode: 'permission_mode',
  sessionMode: 'session_mode',
  persistentNodeId: 'persistent_node_id',
  notify: 'notify',
  enabled: 'enabled',
  autoPaused: 'auto_paused',
  consecutiveFailures: 'consecutive_failures',
  timeoutSeconds: 'timeout_seconds',
  nextRunAt: 'next_run_at',
  lastRunAt: 'last_run_at',
  lastStatus: 'last_status',
  lastError: 'last_error',
  updatedAt: 'updated_at',
};

function columnValue(key: keyof JobUpdate, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (key === 'schedule') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number;
}

export class ScheduledJobsRepository {
  listJobs(): Array<{ record: ScheduledJobRecord; activeRunId: string | null }> {
    const rows = getDb().prepare(`SELECT ${JOB_COLUMNS} FROM scheduled_jobs j WHERE j.execution_kind='scheduled' ORDER BY j.created_at ASC`).all() as unknown as JobRow[];
    return rows.map((row) => ({ record: toRecord(row), activeRunId: row.active_run_id ?? null }));
  }

  listMaintenanceExecutions(): ScheduledJobRecord[] {
    return (getDb().prepare("SELECT * FROM scheduled_jobs WHERE execution_kind='maintenance'").all() as unknown as JobRow[]).map(toRecord);
  }

  countJobs(): number {
    return (getDb().prepare("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE execution_kind='scheduled'").get() as { count: number }).count;
  }

  getJob(id: string): { record: ScheduledJobRecord; activeRunId: string | null } | null {
    const row = getDb().prepare(`SELECT ${JOB_COLUMNS} FROM scheduled_jobs j WHERE j.id = ?`).get(id) as unknown as JobRow | undefined;
    return row ? { record: toRecord(row), activeRunId: row.active_run_id ?? null } : null;
  }

  insertJob(record: ScheduledJobRecord): void {
    getDb().prepare(`
      INSERT INTO scheduled_jobs (
        id, owner_user_id, workspace_id, name, prompt, schedule, runtime_id, provider_id, model_id, reasoning,
        permission_mode, session_mode, persistent_node_id, notify, enabled, auto_paused, consecutive_failures,
        timeout_seconds, next_run_at, last_run_at, last_status, last_error, created_at, updated_at, conversation_cursor, execution_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.ownerUserId, record.workspaceId, record.name, record.prompt, JSON.stringify(record.schedule),
      record.runtimeId, record.providerId, record.modelId, record.reasoning,
      record.permissionMode, record.sessionMode, record.persistentNodeId,
      record.notify ? 1 : 0, record.enabled ? 1 : 0, record.autoPaused ? 1 : 0, record.consecutiveFailures,
      record.timeoutSeconds, record.nextRunAt, record.lastRunAt, record.lastStatus, record.lastError,
      record.createdAt, record.updatedAt,
      record.conversationCursor ?? null, record.executionKind ?? 'scheduled',
    );
  }

  updateJob(id: string, update: JobUpdate): void {
    // undefined means "leave unchanged"; null clears the column.
    const keys = (Object.keys(update) as Array<keyof JobUpdate>).filter((key) => update[key] !== undefined);
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${UPDATE_COLUMNS[key]} = ?`).join(', ');
    const values = keys.map((key) => columnValue(key, update[key]));
    getDb().prepare(`UPDATE scheduled_jobs SET ${assignments} WHERE id = ?`).run(...values, id);
  }

  deleteJob(id: string): boolean {
    const result = getDb().prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** Enabled, unpaused jobs with a stored due time, soonest first. */
  listScheduledJobs(): ScheduledJobRecord[] {
    const rows = getDb().prepare(`
      SELECT j.* FROM scheduled_jobs j
       WHERE j.execution_kind='scheduled' AND j.enabled = 1 AND j.auto_paused = 0 AND j.next_run_at IS NOT NULL
       ORDER BY j.next_run_at ASC
    `).all() as unknown as JobRow[];
    return rows.map(toRecord);
  }

  /** All entrypoints share this transaction, including pending executor starts. */
  claimRun(input: ClaimRunInput): RunAdmissionResult {
    return runInTransaction(() => {
      if (!this.ownsLease(input.lease, input.now)) return { run: null, reason: 'lease_lost' };
      const row = getDb().prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(input.jobId) as unknown as JobRow | undefined;
      if (!row) return { run: null, reason: 'missing' };
      if (input.requireDue && (row.execution_kind !== 'scheduled' || row.enabled !== 1 || row.auto_paused === 1 || row.next_run_at === null || row.next_run_at > input.now)) {
        return { run: null, reason: 'not_due' };
      }
      // A previous holder may still be starting/cancelling an executor. Lease
      // takeover fences commits but cannot prove external work has stopped.
      const foreign = getDb().prepare(`SELECT 1 FROM scheduler_execution_claims
        WHERE holder != ? OR generation != ? OR quarantined_at IS NOT NULL LIMIT 1`).get(input.lease.holder, input.lease.generation);
      if (foreign) return { run: null, reason: 'unresolved_execution' };
      const running = getDb().prepare(`SELECT 1 FROM scheduled_job_runs WHERE job_id = ? AND status = 'running'
        UNION ALL SELECT 1 FROM scheduler_execution_claims WHERE job_id = ? LIMIT 1`).get(input.jobId, input.jobId);
      if (running) return { run: null, reason: 'job_running' };
      if (row.execution_kind === 'maintenance' && getDb().prepare(`SELECT 1 FROM scheduler_execution_claims x
        JOIN scheduled_jobs j ON j.id=x.job_id WHERE j.execution_kind='maintenance' LIMIT 1`).get()) {
        return { run: null, reason: 'capacity' };
      }
      const count = getDb().prepare('SELECT COUNT(*) AS count FROM scheduler_execution_claims').get() as { count: number };
      if (count.count >= input.maxConcurrentRuns) return { run: null, reason: 'capacity' };
      getDb().prepare(`
        INSERT INTO scheduled_job_runs (id, job_id, workspace_id, trigger, status, scheduled_for, started_at, claimed_by)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      `).run(input.runId, input.jobId, row.workspace_id, input.trigger,
        input.requireDue ? row.next_run_at : null, input.now, input.lease.holder);
      getDb().prepare(`INSERT INTO scheduler_execution_claims (run_id, job_id, holder, generation, process_id, acquired_at, workspace_id, process_exit_safe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.runId, input.jobId, input.lease.holder, input.lease.generation, process.pid, input.now, row.workspace_id, input.processExitStopsExecution ? 1 : 0);
      if (input.nextRunAt !== undefined) {
        getDb().prepare('UPDATE scheduled_jobs SET next_run_at = ?, last_run_at = ? WHERE id = ?')
          .run(input.nextRunAt, input.now, input.jobId);
      } else {
        getDb().prepare('UPDATE scheduled_jobs SET last_run_at = ? WHERE id = ?').run(input.now, input.jobId);
      }
      return { run: this.getRun(input.runId)! };
    });
  }

  getRun(id: string): ScheduledJobRunRecord | null {
    const row = getDb().prepare('SELECT * FROM scheduled_job_runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  listRuns(jobId: string, limit: number = SCHEDULED_JOB_LIMITS.runHistoryPerJob): ScheduledJobRunRecord[] {
    const rows = getDb().prepare('SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(jobId, limit) as unknown as RunRow[];
    return rows.map(toRunRecord);
  }

  ownsRun(runId: string, lease: SchedulerLease, now: number): boolean {
    return this.ownsLease(lease, now) && !!getDb().prepare(`SELECT 1 FROM scheduler_execution_claims c
      JOIN scheduled_job_runs r ON r.id = c.run_id
      WHERE c.run_id = ? AND c.holder = ? AND c.generation = ? AND r.status = 'running'`)
      .get(runId, lease.holder, lease.generation);
  }

  attachRunTarget(runId: string, target: { nodeId: string; treeId: string | null; turnId: string | null },
    lease: SchedulerLease, now: number, persistentNodeId?: string): boolean {
    return runInTransaction(() => {
      if (!this.ownsRun(runId, lease, now)) return false;
      getDb().prepare('UPDATE scheduled_job_runs SET node_id = ?, tree_id = ?, turn_id = ? WHERE id = ?')
        .run(target.nodeId, target.treeId, target.turnId, runId);
      if (persistentNodeId) getDb().prepare(`UPDATE scheduled_jobs SET persistent_node_id = ?
        WHERE id = (SELECT job_id FROM scheduled_job_runs WHERE id = ?)`).run(persistentNodeId, runId);
      return true;
    });
  }

  finishRun(runId: string, lease: SchedulerLease, fields: {
    status: Exclude<ScheduledJobRunStatus, 'running'>;
    finishedAt: number;
    summary: string | null;
    error: string | null;
    notify: boolean;
    conversationProgress?: { after: number; nextAfter: number; workspaceId: string; claimedBy: string;
      maintenanceConfigRevision?: number; maintenancePlanId?: string | null; maintenanceOwnerUserId?: string };
  }): boolean {
    return runInTransaction(() => {
      if (!this.ownsRun(runId, lease, fields.finishedAt)) return false;
      let outcome = fields;
      const progress = fields.conversationProgress;
      if (progress && fields.status === 'succeeded') {
        // Cursor CAS and terminal result commit together. A stale/cancelled/blocked run or an
        // expired scheduler lease cannot consume input, even if its executor finishes late.
        let maintenanceReady = true;
        if (progress.maintenanceConfigRevision !== undefined) {
          const config = getDb().prepare(`SELECT c.revision,c.completion_cursor,c.enabled,c.paused,j.enabled AS job_enabled,j.auto_paused,
              r.status,r.claimed_by,r.attention,l.holder,l.expires_at
            FROM scheduled_job_runs r JOIN scheduled_jobs j ON j.id=r.job_id
            JOIN page_maintenance_configs c ON c.job_id=j.id JOIN scheduler_lease l ON l.id=1
            WHERE r.id=? AND j.workspace_id=? AND c.workspace_id=? AND c.owner_user_id=?`)
            .get(runId, progress.workspaceId, progress.workspaceId, progress.maintenanceOwnerUserId ?? 'local-user') as
            {revision:number;completion_cursor:number;enabled:number;paused:number;job_enabled:number;auto_paused:number;
              status:string;claimed_by:string;attention:string|null;holder:string;expires_at:number}|undefined;
          maintenanceReady = !!config && config.revision === progress.maintenanceConfigRevision
            && config.completion_cursor === progress.after && config.enabled === 1 && config.paused === 0
            && config.job_enabled === 1 && config.auto_paused === 0 && config.status === 'running'
            && config.claimed_by === progress.claimedBy && config.attention === null
            && config.holder === progress.claimedBy && config.expires_at > fields.finishedAt;
          // A managed empty batch deliberately avoids a model/plan and leaves the
          // cursor unchanged. Any forward movement must name its durable terminal plan.
          if (maintenanceReady && !progress.maintenancePlanId && progress.nextAfter !== progress.after) maintenanceReady = false;
          if (maintenanceReady && progress.maintenancePlanId) {
            const plan = getDb().prepare(`SELECT p.state,
                NOT EXISTS(SELECT 1 FROM page_maintenance_sources s WHERE s.plan_id=p.id AND s.state NOT IN ('terminal','skipped')) AS terminal
              FROM page_maintenance_plans p WHERE p.id=? AND p.run_id=? AND p.config_revision=?
                AND p.workspace_id=? AND p.owner_user_id=?`)
              .get(progress.maintenancePlanId, runId, progress.maintenanceConfigRevision, progress.workspaceId, progress.maintenanceOwnerUserId ?? 'local-user') as
              {state:string;terminal:number}|undefined;
            maintenanceReady = !!plan && plan.state === 'terminal' && plan.terminal === 1;
          }
        }
        const advanced = maintenanceReady ? getDb().prepare(`UPDATE scheduled_jobs SET conversation_cursor = ?
          WHERE id = (SELECT job_id FROM scheduled_job_runs WHERE id = ? AND status = 'running'
            AND claimed_by = ? AND attention IS NULL) AND workspace_id = ? AND conversation_cursor = ?
            AND EXISTS (SELECT 1 FROM scheduler_lease WHERE id = 1 AND holder = ? AND expires_at > ?)`)
          .run(progress.nextAfter, runId, progress.claimedBy, progress.workspaceId, progress.after, progress.claimedBy, fields.finishedAt)
          : { changes: 0 };
        if (Number(advanced.changes) === 1 && progress.maintenanceConfigRevision !== undefined) {
          const updated = getDb().prepare(`UPDATE page_maintenance_configs SET completion_cursor=?,updated_at=?
            WHERE job_id=(SELECT job_id FROM scheduled_job_runs WHERE id=?) AND workspace_id=? AND owner_user_id=?
              AND completion_cursor=? AND revision=? AND enabled=1 AND paused=0`)
            .run(progress.nextAfter, fields.finishedAt, runId, progress.workspaceId, progress.maintenanceOwnerUserId ?? 'local-user', progress.after, progress.maintenanceConfigRevision);
          if (Number(updated.changes) !== 1) {
            getDb().prepare('UPDATE scheduled_jobs SET conversation_cursor=? WHERE id=(SELECT job_id FROM scheduled_job_runs WHERE id=?)')
              .run(progress.after, runId);
            maintenanceReady = false;
          }
        }
        if (Number(advanced.changes) !== 1 || !maintenanceReady) {
          outcome = { ...fields, status: 'failed', error: 'Conversation progress was not advanced: consumer changed or run lease expired' };
        }
      }
      const result = getDb().prepare(`
        UPDATE scheduled_job_runs
           SET status = ?, finished_at = ?, summary = ?, error = ?,
               notify_state = CASE WHEN ? = 1 THEN 'pending' ELSE notify_state END,
               notify_kind = CASE WHEN ? = 1 THEN 'finished' ELSE notify_kind END
         WHERE id = ? AND status = 'running'
      `).run(outcome.status, outcome.finishedAt, outcome.summary, outcome.error,
        outcome.notify ? 1 : 0, outcome.notify ? 1 : 0, runId);
      return Number(result.changes) > 0;
    });
  }

  updateFinishedJob(runId: string, lease: SchedulerLease, now: number, update: JobUpdate): boolean {
    return runInTransaction(() => {
      if (!this.ownsLease(lease, now)) return false;
      const claim = getDb().prepare(`SELECT job_id FROM scheduler_execution_claims
        WHERE run_id = ? AND holder = ? AND generation = ?`).get(runId, lease.holder, lease.generation) as { job_id: string } | undefined;
      if (!claim) return false;
      this.updateJob(claim.job_id, update);
      return true;
    });
  }

  markAttention(runId: string, attention: 'approval' | 'input', lease: SchedulerLease, now: number): boolean {
    return runInTransaction(() => {
      if (!this.ownsRun(runId, lease, now)) return false;
      getDb().prepare(`UPDATE scheduled_job_runs SET attention = ?, notify_state = 'pending', notify_kind = 'attention'
        WHERE id = ?`).run(attention, runId);
      return true;
    });
  }

  /** This acknowledgment is allowed after lease loss, but only for this claim. */
  releaseExecution(runId: string, lease: SchedulerLease): void {
    getDb().prepare('DELETE FROM scheduler_execution_claims WHERE run_id = ? AND holder = ? AND generation = ?')
      .run(runId, lease.holder, lease.generation);
  }

  markNotified(runId: string): boolean {
    const result = getDb().prepare(`UPDATE scheduled_job_runs SET notify_state = 'delivered' WHERE id = ? AND notify_state = 'pending'`).run(runId);
    return Number(result.changes) > 0;
  }

  /** Undelivered notifications, newest last. */
  pendingNotifications(since: number): ScheduledJobRunRecord[] {
    const rows = getDb().prepare(`
      SELECT * FROM scheduled_job_runs
       WHERE notify_state = 'pending'
         AND COALESCE(finished_at, started_at) >= ?
         AND (notify_kind = 'finished' OR status = 'running')
       ORDER BY COALESCE(finished_at, started_at) ASC
       LIMIT 20
    `).all(since) as unknown as RunRow[];
    return rows.map(toRunRecord);
  }

  /** Fence records from older ownership; reservations remain until termination is known. */
  interruptStaleRuns(lease: SchedulerLease, now: number): number {
    return runInTransaction(() => {
      if (!this.ownsLease(lease, now)) return 0;
      // Also quarantine untracked rows created by an older backend sharing
      // this database. They have no trustworthy process identity.
      getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
        (run_id, job_id, holder, generation, acquired_at, workspace_id, quarantined_at, reason)
        SELECT id, job_id, claimed_by, 0, started_at, workspace_id, ?,
          'An earlier Michi version did not confirm that this execution stopped'
        FROM scheduled_job_runs WHERE status = 'running'`).run(now);
      getDb().prepare(`UPDATE scheduler_execution_claims SET quarantined_at = COALESCE(quarantined_at, ?),
        reason = COALESCE(reason, 'Scheduler ownership changed; the previous execution has not confirmed it stopped')
        WHERE holder != ? OR generation != ?`).run(now, lease.holder, lease.generation);
      const result = getDb().prepare(`UPDATE scheduled_job_runs
        SET status = 'interrupted', finished_at = ?, error = 'Scheduler ownership changed while this run was in progress',
            notify_state = CASE WHEN notify_state = 'pending' AND notify_kind = 'attention' THEN 'none' ELSE notify_state END
        WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM scheduler_execution_claims c
          WHERE c.run_id = scheduled_job_runs.id AND c.holder = ? AND c.generation = ?)`)
        .run(now, lease.holder, lease.generation);
      return Number(result.changes);
    });
  }

  interruptExecution(runId: string, lease: SchedulerLease, now: number): void {
    this.quarantineExecution(runId, lease, now, 'Scheduler ownership changed; the previous execution has not confirmed it stopped');
    getDb().prepare(`UPDATE scheduled_job_runs SET status = 'interrupted', finished_at = ?,
      error = 'Scheduler ownership changed while this run was in progress',
      notify_state = CASE WHEN notify_kind = 'attention' THEN 'none' ELSE notify_state END
      WHERE id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM scheduler_execution_claims c
        WHERE c.run_id = scheduled_job_runs.id AND c.holder = ? AND c.generation = ?)`)
      .run(now, runId, lease.holder, lease.generation);
  }

  quarantineExecution(runId: string, lease: SchedulerLease, now: number, reason: string): void {
    getDb().prepare(`UPDATE scheduler_execution_claims SET quarantined_at = COALESCE(quarantined_at, ?), reason = COALESCE(reason, ?)
      WHERE run_id = ? AND holder = ? AND generation = ?`).run(now, reason, runId, lease.holder, lease.generation);
  }

  blockedExecutions(): ScheduledJobBlockedExecution[] {
    return (getDb().prepare(`SELECT run_id, job_id, workspace_id, reason, quarantined_at FROM scheduler_execution_claims
      WHERE quarantined_at IS NOT NULL ORDER BY quarantined_at`).all() as Array<{
      run_id: string; job_id: string; workspace_id: string; reason: string; quarantined_at: number;
    }>).map(row => ({ runId: row.run_id, jobId: row.job_id, workspaceId: row.workspace_id, reason: row.reason, since: row.quarantined_at }));
  }

  confirmExecutionStopped(runId: string): 'released' | 'missing' | 'active' {
    return runInTransaction(() => {
      const row = getDb().prepare('SELECT process_id, quarantined_at FROM scheduler_execution_claims WHERE run_id = ?')
        .get(runId) as { process_id: number | null; quarantined_at: number | null } | undefined;
      if (!row) return 'missing';
      if (row.quarantined_at === null) return 'active';
      if (row.process_id) {
        try { process.kill(row.process_id, 0); return 'active'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'active'; }
      }
      getDb().prepare('DELETE FROM scheduler_execution_claims WHERE run_id = ?').run(runId);
      return 'released';
    });
  }

  /** ESRCH proves that a process is absent. PID reuse/EPERM/unknown legacy PIDs
   * deliberately retain occupancy; they cannot establish executor termination. */
  reapExitedExecutions(lease: SchedulerLease, now: number): number {
    return runInTransaction(() => {
      if (!this.ownsLease(lease, now)) return 0;
      const claims = getDb().prepare(`SELECT run_id, process_id FROM scheduler_execution_claims
        WHERE (holder != ? OR generation != ?) AND process_exit_safe = 1`).all(lease.holder, lease.generation) as Array<{ run_id: string; process_id: number | null }>;
      let reaped = 0;
      for (const claim of claims) {
        if (!claim.process_id || claim.process_id === process.pid) continue;
        try { process.kill(claim.process_id, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
          reaped += Number(getDb().prepare('DELETE FROM scheduler_execution_claims WHERE run_id = ?').run(claim.run_id).changes);
        }
      }
      return reaped;
    });
  }

  pruneRuns(jobId: string, keep: number = SCHEDULED_JOB_LIMITS.runHistoryPerJob): void {
    getDb().prepare(`
      DELETE FROM scheduled_job_runs
       WHERE job_id = ? AND status != 'running' AND NOT EXISTS (SELECT 1 FROM scheduler_execution_claims c WHERE c.run_id = scheduled_job_runs.id) AND id NOT IN (
         SELECT id FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
       )
    `).run(jobId, jobId, keep);
  }

  ownsLease(lease: SchedulerLease, now: number): boolean {
    return !!getDb().prepare(`SELECT 1 FROM scheduler_lease WHERE id = 1 AND holder = ? AND generation = ? AND expires_at > ?`)
      .get(lease.holder, lease.generation, now);
  }

  /** A new generation is issued even when the same holder returns after expiry. */
  acquireLease(holder: string, now: number, ttlMs: number): SchedulerLease | null {
    return runInTransaction(() => {
      const row = getDb().prepare('SELECT holder, expires_at, generation FROM scheduler_lease WHERE id = 1').get() as
        { holder: string; expires_at: number; generation: number } | undefined;
      if (row && row.holder !== holder && row.expires_at > now) return null;
      const generation = row && row.holder === holder && row.expires_at > now ? row.generation : (row?.generation ?? 0) + 1;
      getDb().prepare(`INSERT INTO scheduler_lease (id, holder, expires_at, generation) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at, generation = excluded.generation`)
        .run(holder, now + ttlMs, generation);
      return { holder, generation };
    });
  }

  releaseLease(lease: SchedulerLease): void {
    getDb().prepare('UPDATE scheduler_lease SET expires_at = 0 WHERE id = 1 AND holder = ? AND generation = ?')
      .run(lease.holder, lease.generation);
  }
}
