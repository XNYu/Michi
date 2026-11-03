import { maintenanceCoordinatorState } from '../metaAgent/maintenanceCoordinator';
import type { MaintenanceWorkspaceResponse } from 'michi-shared';
import { conversationCompletionCounter } from '../conversationUpdates';
import type { ScheduledJobScheduler } from '../scheduledJobs/scheduler';
import { getMaintenanceConfig, listEligibleMaintenanceManifest, listMaintenanceBacklog, listMaintenanceCatchupSuggestions,
  listMaintenanceExcludedSpaces, type MaintenanceManifest } from './maintenanceRepository';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { resolveMetaAgentRuntime } from '../metaAgent/settings';
import { getWorkspaceInstructions, listWatches } from '../metaAgent/watches';

export type MaintenanceWorkspaceView = MaintenanceWorkspaceResponse;

export function maintenanceManifest(workspaceId: string, ownerUserId: string): MaintenanceManifest {
  // Repository manifests are complete and versioned; do not cap at the conversation-feed page size.
  return listEligibleMaintenanceManifest(workspaceId, ownerUserId);
}

export function getMaintenanceWorkspaceView(input: {
  workspaceId: string; ownerUserId: string; scheduler: ScheduledJobScheduler; now?: number;
}): MaintenanceWorkspaceView {
  const config = getMaintenanceConfig(input.workspaceId, input.ownerUserId);
  const backlog = config ? listMaintenanceBacklog(input.workspaceId, input.ownerUserId)
    : { plans: [], pendingSources: 0, attentionSources: 0 };
  const job = config ? (() => { try { return input.scheduler.getJob(config.jobId); } catch { return null; } })() : null;
  const lastRun = config ? input.scheduler.listRuns(config.jobId)[0] ?? null : null;
  const excludedSpaceIds = listMaintenanceExcludedSpaces(input.workspaceId, input.ownerUserId);
  const catchUpSuggestions = config ? listMaintenanceCatchupSuggestions(input.workspaceId, input.ownerUserId) : [];
  const runtime = resolveMetaAgentRuntime(input.ownerUserId);
  const unavailable = config ? maintenanceRuntimeAvailability(runtime.runtimeId).available === false : false;
  return {
    config,
    status: config ? {
      completionCounter: conversationCompletionCounter(input.workspaceId),
      lastRun,
      pendingSources: backlog.pendingSources,
      attentionSources: backlog.attentionSources,
    } : null,
    backlog, job, scheduler: !job || unavailable ? 'unavailable' : (config?.paused || maintenanceCoordinatorState(input.ownerUserId).paused) ? 'paused' : 'available', excludedSpaceIds,
    catchUpSuggestions, runtime,
    instructions: getWorkspaceInstructions(input.workspaceId, input.ownerUserId),
    watches: listWatches(input.workspaceId, input.ownerUserId),
  };
}
