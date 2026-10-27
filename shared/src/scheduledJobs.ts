import type { ChatPermissionMode } from './chatPermissions';

/**
 * Scheduled Jobs: a prompt that the backend runs on a schedule without any
 * renderer attached. Each run is an ordinary durable chat turn, so the result
 * is opened like any other thread.
 */

export type ScheduledJobSchedule =
  /** Fixed interval measured from the previous run. */
  | { kind: 'every'; everySeconds: number }
  /** Standard 5-field cron expression evaluated in `timezone` (IANA). */
  | { kind: 'cron'; expression: string; timezone: string | null }
  /** One-shot run at an epoch-ms instant. */
  | { kind: 'at'; at: number };

export type ScheduledJobScheduleKind = ScheduledJobSchedule['kind'];

/** fresh: every run opens a new thread. persistent: runs append to one thread. */
export type ScheduledJobSessionMode = 'fresh' | 'persistent';

export type ScheduledJobRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted';

export type ScheduledJobRunTrigger = 'scheduled' | 'manual';

export interface ScheduledJobDto {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduledJobSchedule;
  /** null = the runtime configured in Settings at run time. */
  runtimeId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: ChatPermissionMode;
  sessionMode: ScheduledJobSessionMode;
  notify: boolean;
  enabled: boolean;
  /** Set after repeated failures; cleared by resuming the job. */
  autoPaused: boolean;
  timeoutSeconds: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduledJobRunStatus | null;
  lastError: string | null;
  consecutiveFailures: number;
  activeRunId: string | null;
  persistentNodeId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Internal opt-in consumer progress. null/absent means an ordinary job. */
  conversationCursor?: number | null;
}

export interface ScheduledJobRunDto {
  id: string;
  jobId: string;
  workspaceId: string;
  nodeId: string | null;
  treeId: string | null;
  trigger: ScheduledJobRunTrigger;
  status: ScheduledJobRunStatus;
  scheduledFor: number | null;
  startedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
}

export interface ScheduledJobInput {
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduledJobSchedule;
  runtimeId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: string | null;
  permissionMode?: ChatPermissionMode;
  sessionMode?: ScheduledJobSessionMode;
  notify?: boolean;
  enabled?: boolean;
  timeoutSeconds?: number;
  /** Start consuming newly completed turns from now; false disables consumption. */
  conversationUpdates?: boolean;
}

export type ScheduledJobPatch = Partial<ScheduledJobInput>;

export interface ScheduledJobBlockedExecution {
  runId: string;
  jobId: string;
  workspaceId: string;
  reason: string;
  since: number;
}

export interface ScheduledJobsSchedulerStatus {
  /** Unconfirmed execution lifetimes block data-directory-wide admission. */
  blockedExecutions?: ScheduledJobBlockedExecution[];
  /** False when another Michi process on the same data directory owns scheduling. */
  active: boolean;
  /** True when this backend runs as the always-on background service. */
  serviceMode: boolean;
  /** Default timezone for new cron schedules. */
  timezone: string;
}

export interface ScheduledJobsListResponse {
  jobs: ScheduledJobDto[];
  scheduler: ScheduledJobsSchedulerStatus;
}

export interface ScheduledJobPreviewResponse {
  valid: boolean;
  error?: string;
  nextRuns: number[];
}

/** SSE event name shared by the renderer background feed and the Electron notification feed. */
export const SCHEDULED_JOB_RUN_EVENT = 'scheduled_job_run';

export type ScheduledJobRunEventPhase = 'started' | 'finished' | 'attention';

export interface ScheduledJobRunEvent {
  phase: ScheduledJobRunEventPhase;
  runId: string;
  jobId: string;
  jobName: string;
  workspaceId: string;
  nodeId: string | null;
  treeId: string | null;
  status: ScheduledJobRunStatus;
  summary: string | null;
  error: string | null;
  /** Whether the job asked for a completion notification. */
  notify: boolean;
  /** What a blocked run is waiting for (phase=attention only). */
  attention?: 'approval' | 'input';
  at: number;
}

/**
 * SSE event on the renderer background feed when a job is created, edited or
 * deleted (from any window or by an agent tool), so open Scheduled views
 * refresh. Not sent to the Electron notification feed.
 */
export const SCHEDULED_JOBS_CHANGED_EVENT = 'scheduled_jobs_changed';

export interface ScheduledJobsChangedEvent {
  change: 'created' | 'updated' | 'deleted';
  jobId: string;
  workspaceId: string;
  at: number;
}

export function isScheduledJobsChangedEvent(value: unknown): value is ScheduledJobsChangedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (event.change === 'created' || event.change === 'updated' || event.change === 'deleted')
    && typeof event.jobId === 'string'
    && typeof event.workspaceId === 'string';
}

export const SCHEDULED_JOB_LIMITS = {
  name: 120,
  prompt: 32_000,
  cronExpression: 200,
  minEverySeconds: 60,
  maxEverySeconds: 366 * 24 * 3600,
  minTimeoutSeconds: 60,
  maxTimeoutSeconds: 24 * 3600,
  defaultTimeoutSeconds: 30 * 60,
  maxJobs: 200,
  /** Consecutive failures that pause a job automatically. */
  autoPauseThreshold: 5,
  runHistoryPerJob: 50,
} as const;

export function isScheduledJobRunStatus(value: unknown): value is ScheduledJobRunStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed'
    || value === 'cancelled' || value === 'timed_out' || value === 'interrupted';
}

export function isScheduledJobRunEvent(value: unknown): value is ScheduledJobRunEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (event.phase === 'started' || event.phase === 'finished' || event.phase === 'attention')
    && typeof event.runId === 'string'
    && typeof event.jobId === 'string'
    && typeof event.jobName === 'string'
    && typeof event.workspaceId === 'string'
    && (event.nodeId === null || typeof event.nodeId === 'string')
    && isScheduledJobRunStatus(event.status);
}
