import { maintenanceHasWork, maintenanceCoordinatorState } from './maintenanceCoordinator';
import type {
  MetaAgentRoundStatus, MetaAgentRunNowResponse, MetaAgentRunNowSkip, MetaAgentRunNowWorkspace,
} from 'michi-shared';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { conversationCompletionCounter } from '../conversationUpdates';
import type { ScheduledJobScheduler } from '../scheduledJobs/scheduler';
import { getMetaAgentGuardStatus, metaAgentGuardStatusMessage } from './guardStatus';
import { resolveMetaAgentRuntime } from './settings';
import { listMaintenanceConfigs, type MaintenanceConfigRow } from './todayUsage';

const unread = (config: MaintenanceConfigRow) => Math.max(0, conversationCompletionCounter(config.workspace_id) - config.completion_cursor);

/** Start pending work now; capacity-limited work remains discoverable by the
 * global coordinator. Empty checks create neither runs nor model sessions. */
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
    if (maintenanceCoordinatorState(ownerUserId).paused || config.paused === 1) return skipped('paused', 'Maintenance is paused in this workspace');
    if (config.auto_paused === 1) return skipped('stopped', config.last_error ? `Stopped after repeated failures: ${config.last_error}` : 'Stopped after repeated failures');
    if (!maintenanceHasWork(config.workspace_id, ownerUserId, scheduler.now())) return { ...base, outcome: 'no_new' };
    try {
      const started = scheduler.startNow(config.job_id);
      if ('run' in started) return { ...base, outcome: 'started', runId: started.run.id };
      if (started.refused === 'running') return { ...base, outcome: 'started', runId: started.activeRunId, reason: 'Already reading' };
      if (started.refused === 'no_work') return { ...base, outcome: 'no_new' };
      if (started.refused === 'capacity') {
        queued.push(config.job_id);
        return { ...base, outcome: 'started', runId: null, reason: 'Starts when a run slot frees up' };
      }
      return skipped('unavailable', started.message);
    } catch (error) {
      return skipped('unavailable', error instanceof Error ? error.message : String(error));
    }
  });
  // Wake the coordinator; its admission and pause checks still apply.
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
        const runtime = resolveMetaAgentRuntime(input.ownerUserId);
        const held = getMetaAgentGuardStatus('maintenance', () => runtime, input.ownerUserId)?.state === 'failed';
        running = job.activeRunId !== null || (job.enabled && !job.autoPaused && !held
          && maintenanceRuntimeAvailability(runtime.runtimeId).available
          && maintenanceHasWork(config.workspace_id, input.ownerUserId, input.now));
      } catch {
        // A config whose job is gone runs nothing.
      }
      return { workspaceId: config.workspace_id, cursor: config.completion_cursor, unread: unread(config), running };
    }),
  };
}
