import { getDb } from '../db';
import { log } from '../logger';
import { conversationCompletionCounter } from '../conversationUpdates';
import { getMaintenanceConfig, listMaintenanceBacklog, listQueuedMaintenanceRequests, maintenancePlanWaitsOnEditLeases } from '../pages/maintenanceRepository';
import { homeMaintenancePending } from './firstRun';
import { watchDue } from './watches';
import type { ScheduledJobRecord } from '../scheduledJobs/repository';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../agentOwner';
import { isSystemWorkspaceSettings } from 'michi-shared';
import { isMemoryExtractionJob } from '../memory/extractionRepository';
import { memoryExtractionHasWork } from '../memory/extractionRun';

export const MAINTENANCE_CHECK_INTERVAL_MS = 60_000;

export function maintenanceCoordinatorState(ownerUserId: string): { paused: boolean; lastCheckedAt: number | null } {
  const row = getDb().prepare('SELECT paused,last_checked_at FROM meta_agent_maintenance_state WHERE owner_user_id=?')
    .get(ownerUserId) as { paused: number; last_checked_at: number | null } | undefined;
  return { paused: row?.paused === 1, lastCheckedAt: row?.last_checked_at ?? null };
}

export function pauseMaintenanceCoordinator(ownerUserId: string, paused: boolean): void {
  getDb().prepare(`INSERT INTO meta_agent_maintenance_state(owner_user_id,paused) VALUES(?,?)
    ON CONFLICT(owner_user_id) DO UPDATE SET paused=excluded.paused`).run(ownerUserId, paused ? 1 : 0);
}

/** Database-only discovery; no run, session or model is created by a check. */
export function maintenanceHasWork(workspaceId: string, ownerUserId: string, now: number): boolean {
  const config = getMaintenanceConfig(workspaceId, ownerUserId);
  if (!config || !config.enabled || config.paused || maintenanceCoordinatorState(ownerUserId).paused) return false;
  const workspace = getDb().prepare('SELECT owner_user_id,settings FROM workspaces WHERE id=? AND deleted_at IS NULL AND purged_at IS NULL AND archived_at IS NULL')
    .get(workspaceId) as { owner_user_id: string | null; settings: string | null } | undefined;
  if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id, ownerUserId) || isSystemWorkspaceSettings(workspace.settings)) return false;
  if (homeMaintenancePending(workspaceId, ownerUserId, now)) return true;
  // A due watch runs ahead of conversation work (scheduler.execute), so a plan waiting on edit leases does not hold it.
  if (watchDue(workspaceId, ownerUserId, now)) return true;
  if (listQueuedMaintenanceRequests(workspaceId, ownerUserId).length) return true;
  // A run resumes the first unfinished plan before it reads new turns (scheduler.execute). While
  // that plan only waits for conversations editing its pages, a run could do nothing but defer again.
  const unfinished = listMaintenanceBacklog(workspaceId, ownerUserId).plans.find(plan => plan.state === 'routing' || plan.state === 'processing');
  if (unfinished) return !maintenancePlanWaitsOnEditLeases(unfinished.id, ownerUserId, now).waiting;
  return conversationCompletionCounter(workspaceId) > config.completionCursor;
}

/**
 * Discovery for one execution identity. A workspace has up to two: its Pages
 * maintenance, and its automatic memory extraction (memory/extractionRun.ts),
 * which shares this coordinator's lease, capacity, backoff and pauses.
 */
export function maintenanceExecutionHasWork(record: Pick<ScheduledJobRecord, 'id' | 'workspaceId' | 'ownerUserId'>, now: number): boolean {
  const ownerUserId = record.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
  if (isMemoryExtractionJob(record.id)) return memoryExtractionHasWork({ jobId: record.id, workspaceId: record.workspaceId, ownerUserId }, now);
  return maintenanceHasWork(record.workspaceId, ownerUserId, now);
}

/** One coordinator shares the existing host lease and execution admission.
 * Workspace records are execution identities, not independently timed jobs.
 * Pending work is durable in plans/cursors/requests; wakeups are only hints.
 */
export class MaintenanceCoordinator {
  private nextCheckAt = 0;
  wake(): void { this.nextCheckAt = 0; }

  check(now: number, records: ScheduledJobRecord[], start: (record: ScheduledJobRecord) => boolean): void {
    if (now < this.nextCheckAt) return;
    this.nextCheckAt = now + MAINTENANCE_CHECK_INTERVAL_MS;
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const dayStart = day.getTime();
    const owners = new Set(records.map(record => record.ownerUserId ?? LOCAL_AGENT_OWNER_ID));
    for (const owner of owners) {
      getDb().prepare(`INSERT INTO meta_agent_maintenance_state(owner_user_id,last_checked_at,check_day_start,check_count) VALUES(?,?,?,1)
        ON CONFLICT(owner_user_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,
          check_day_start=excluded.check_day_start,
          check_count=CASE WHEN meta_agent_maintenance_state.check_day_start=excluded.check_day_start
            THEN meta_agent_maintenance_state.check_count+1 ELSE 1 END`).run(owner, now, dayStart);
    }
    // Least recently served first; a busy workspace yields after every batch.
    records.sort((a, b) => (a.lastRunAt ?? -1) - (b.lastRunAt ?? -1) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const record of records) {
      if (!record.enabled || record.autoPaused) continue;
      const retryMs = Math.min(60 * 60_000, MAINTENANCE_CHECK_INTERVAL_MS * 2 ** Math.min(6, Math.max(0, record.consecutiveFailures - 1)));
      if (record.consecutiveFailures > 0 && record.lastRunAt !== null && now < record.updatedAt + retryMs) continue;
      try {
        if (!maintenanceExecutionHasWork(record, now)) continue;
        if (start(record)) break;
      } catch (error) {
        log.warn('scheduler', 'maintenance discovery failed', { workspaceId: record.workspaceId, error: String(error) });
      }
    }
  }
}
