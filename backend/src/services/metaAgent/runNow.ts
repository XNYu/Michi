import type {
  MetaAgentRoundStatus, MetaAgentRunNowResponse, MetaAgentRunNowSkip, MetaAgentRunNowWorkspace,
} from 'michi-shared';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { conversationCompletionCounter } from '../conversationUpdates';
import { listMaintenanceBacklog, listQueuedMaintenanceRequests } from '../pages/maintenanceRepository';
import type { ScheduledJobScheduler } from '../scheduledJobs/scheduler';
import { getMetaAgentGuardStatus, metaAgentGuardStatusMessage } from './guardStatus';
import { resolveMetaAgentRuntime } from './settings';
import { listMaintenanceConfigs, type MaintenanceConfigRow } from './todayUsage';

const unread = (config: MaintenanceConfigRow) => Math.max(0, conversationCompletionCounter(config.workspace_id) - config.completion_cursor);

/** New conversations, or work a run would pick up before them: a queued reconsider or catch-up, an unfinished plan. */
function hasWork(config: MaintenanceConfigRow, ownerUserId: string): boolean {
  if (unread(config) > 0) return true;
  if (listQueuedMaintenanceRequests(config.workspace_id, ownerUserId).length > 0) return true;
  return listMaintenanceBacklog(config.workspace_id, ownerUserId).plans.some((plan) => plan.state === 'routing' || plan.state === 'processing');
}

/**
 * Starts one Meta agent round now. Each maintained workspace with something
 * to read starts its managed maintenance job, which reads one bounded page
 * exactly as its 60-second schedule would; a workspace with nothing new
 * starts nothing and calls no model. The holds the schedule obeys (a paused
 * workspace, a failed restriction check, a runtime the Meta agent cannot
 * run on, a job stopped after failures) skip the workspace with the reason.
 */
export function runMetaAgentRoundNow(input: { scheduler: ScheduledJobScheduler; ownerUserId: string }): MetaAgentRunNowResponse {
  const { scheduler, ownerUserId } = input;
  const runtime = resolveMetaAgentRuntime(ownerUserId);
  const availability = maintenanceRuntimeAvailability(runtime.runtimeId);
  const guard = availability.available ? getMetaAgentGuardStatus('maintenance', () => runtime, ownerUserId) : null;
  const queued: string[] = [];
  const workspaces = listMaintenanceConfigs(ownerUserId).map((config): MetaAgentRunNowWorkspace => {
    const base = { workspaceId: config.workspace_id, workspaceName: config.workspace_name, cursor: config.completion_cursor, unread: unread(config) };
    const skipped = (skip: MetaAgentRunNowSkip, reason: string): MetaAgentRunNowWorkspace => ({ ...base, outcome: 'skipped', skip, reason });
    if (!availability.available) return skipped('unsupported_runtime', availability.reason ?? `The Meta agent cannot run on ${runtime.runtimeId}`);
    if (guard?.state === 'failed') return skipped('guard_hold', metaAgentGuardStatusMessage(guard));
    if (config.paused === 1) return skipped('paused', 'Maintenance is paused in this workspace');
    if (config.auto_paused === 1) return skipped('stopped', config.last_error ? `Stopped after repeated failures: ${config.last_error}` : 'Stopped after repeated failures');
    if (!hasWork(config, ownerUserId)) return { ...base, outcome: 'no_new' };
    try {
      const started = scheduler.startNow(config.job_id);
      if ('run' in started) return { ...base, outcome: 'started', runId: started.run.id };
      if (started.refused === 'running') return { ...base, outcome: 'started', runId: started.activeRunId, reason: 'Already reading' };
      if (started.refused === 'capacity') {
        queued.push(config.job_id);
        return { ...base, outcome: 'started', runId: null, reason: 'Starts when a run slot frees up' };
      }
      return skipped('unavailable', started.message);
    } catch (error) {
      return skipped('unavailable', error instanceof Error ? error.message : String(error));
    }
  });
  // Due now, so the scheduler starts them as soon as a run ends; its own checks apply then.
  if (queued.length > 0) scheduler.wakeJobs(queued);
  return { workspaces };
}

/** Where each maintained workspace stands while a round runs. */
export function metaAgentRoundStatus(input: { scheduler: ScheduledJobScheduler; ownerUserId: string; now: number }): MetaAgentRoundStatus {
  return {
    workspaces: listMaintenanceConfigs(input.ownerUserId).map((config) => {
      let running = false;
      try {
        const job = input.scheduler.getJob(config.job_id);
        running = job.activeRunId !== null || (job.nextRunAt !== null && job.nextRunAt <= input.now && hasWork(config, input.ownerUserId));
      } catch {
        // A config whose job is gone runs nothing.
      }
      return { workspaceId: config.workspace_id, cursor: config.completion_cursor, unread: unread(config), running };
    }),
  };
}
