import type { MaintenanceConfig, ScheduledJobDto } from 'michi-shared';
import type { ScheduledJobScheduler } from '../scheduledJobs/scheduler';
import type { ScheduledJobSchedule } from 'michi-shared';
import { PageWriteError } from './core';
import {
  createMaintenanceConfig, getMaintenanceConfig, updateMaintenanceConfig,
  type UpdateMaintenanceConfigInput,
} from './maintenanceRepository';

const MANAGED_PROMPT = 'Review completed workspace conversations for relevant Space updates. Record only verified maintenance decisions.';

/** Runtime fields of the managed job: always null, the run resolves the Meta agent settings when it starts. */
const NO_RUNTIME_PROFILE = { runtimeId: null, providerId: null, modelId: null, reasoning: null } as const;

/** Kept for callers that map it; config and settings writes no longer check runtime availability. */
export class MaintenanceRuntimeUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'MaintenanceRuntimeUnavailableError'; }
}

type RuntimeProfileInput = Partial<Record<'runtimeId' | 'providerId' | 'modelId' | 'reasoning', string | null>>;

function refuseRuntimeProfile(input: RuntimeProfileInput): void {
  for (const key of ['runtimeId', 'providerId', 'modelId', 'reasoning'] as const) {
    if (input[key] !== undefined && input[key] !== null) {
      throw new PageWriteError(400, 'invalid', 'Space maintenance runs on the Meta agent settings; change the runtime there');
    }
  }
}

/** Creates/updates the internal execution identity bound to a workspace maintenance config. */
export class PageMaintenanceConfigService {
  constructor(private readonly scheduler: ScheduledJobScheduler, private readonly clock: () => number = Date.now) {}

  get(workspaceId: string, ownerUserId: string): MaintenanceConfig | null {
    return getMaintenanceConfig(workspaceId, ownerUserId);
  }

  enable(input: {
    workspaceId: string; ownerUserId: string; expectedRevision?: number;
    enabled?: boolean; paused?: boolean;
  } & RuntimeProfileInput): { config: MaintenanceConfig; job: ScheduledJobDto } {
    refuseRuntimeProfile(input);
    const current = getMaintenanceConfig(input.workspaceId, input.ownerUserId);
    const now = this.clock();
    if (!current) {
      if (input.expectedRevision !== undefined) throw new Error('Maintenance config does not exist');
      const job = this.scheduler.createMaintenanceExecution({
        workspaceId: input.workspaceId, name: 'Space maintenance', prompt: MANAGED_PROMPT,
        schedule: { kind: 'every', everySeconds: 60 } satisfies ScheduledJobSchedule,
        ...NO_RUNTIME_PROFILE,
        permissionMode: 'trust', sessionMode: 'fresh', notify: false, enabled: input.enabled !== false && input.paused !== true,
        timeoutSeconds: 3600, conversationUpdates: true,
      }, input.ownerUserId);
      try {
        const config = createMaintenanceConfig({ workspaceId: input.workspaceId, ownerUserId: input.ownerUserId,
          jobId: job.id, now, enabled: input.enabled !== false, paused: input.paused === true });
        return { config, job: this.scheduler.getJob(job.id) };
      } catch (error) {
        this.scheduler.deleteJob(job.id);
        throw error;
      }
    }
    if (input.expectedRevision === undefined) throw new Error('expectedRevision is required');
    const config = updateMaintenanceConfig({ workspaceId: input.workspaceId, ownerUserId: input.ownerUserId,
      expectedRevision: input.expectedRevision, now, enabled: input.enabled, paused: input.paused });
    const job = this.scheduler.updateJob(config.jobId, { enabled: config.enabled && !config.paused, ...NO_RUNTIME_PROFILE,
      schedule: { kind: 'every', everySeconds: 60 } });
    return { config, job };
  }

  /** A saved exclusion config may exist before the managed job is enabled. */
  update(input: UpdateMaintenanceConfigInput & RuntimeProfileInput): MaintenanceConfig {
    refuseRuntimeProfile(input);
    const config = updateMaintenanceConfig({ workspaceId: input.workspaceId, ownerUserId: input.ownerUserId,
      expectedRevision: input.expectedRevision, now: input.now, enabled: input.enabled, paused: input.paused });
    this.scheduler.updateJob(config.jobId, { enabled: config.enabled && !config.paused, ...NO_RUNTIME_PROFILE,
      schedule: { kind: 'every', everySeconds: 60 } });
    return config;
  }
}
