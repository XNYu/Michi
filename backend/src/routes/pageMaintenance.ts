import { Router, type NextFunction, type Request, type Response } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError, requirePagesWorkspace } from '../services/pages/core';
import { getAiGlobalContext } from '../services/dbRepository';
import { queueMaintenanceCatchup, queueMaintenanceReconsider, setInitialSpaceMaintenanceExcluded, setSpaceMaintenanceExcluded } from '../services/pages/maintenanceRepository';
import { getMaintenanceWorkspaceView } from '../services/pages/maintenanceRouting';
import { MaintenanceRuntimeUnavailableError, PageMaintenanceConfigService } from '../services/pages/maintenanceConfig';
import type { ScheduledJobScheduler } from '../services/scheduledJobs/scheduler';
import { JobValidationError, ScheduledJobConflictError, ScheduledJobNotFoundError } from '../services/scheduledJobs/scheduler';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const owner = (req: Request): string => process.env.MICHI_CLOUD === '1'
  ? (req as Request & { user?: { id?: string } }).user?.id ?? ''
  : LOCAL_AGENT_OWNER_ID;
const id = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new PageWriteError(400, 'invalid', 'expectedRevision must be a positive integer');
  return value as number;
};
class MaintenanceNavigationDisabledError extends Error {}
function requireMaintenanceNavigation(workspaceId: string, ownerUserId: string): void {
  if (!getAiGlobalContext(workspaceId, ownerUserId)) throw new MaintenanceNavigationDisabledError('AI navigation is disabled for this workspace');
}
function checkBody(req: Request, allowed: string[]): Obj {
  if (req.body === undefined && allowed.length === 0) return {};
  if (!isObject(req.body) || Object.keys(req.body).some((key) => !allowed.includes(key))) throw new PageWriteError(400, 'invalid', 'Invalid request body');
  return req.body;
}
function route(fn: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
}
function errors(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof MaintenanceNavigationDisabledError) { res.status(403).json({ error: { code: 'navigation_disabled', message: error.message } }); return; }
  if (error instanceof MaintenanceRuntimeUnavailableError) { res.status(409).json({ error: { code: 'runtime_unavailable', message: error.message } }); return; }
  if (error instanceof PageWriteError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  if (error instanceof ScheduledJobNotFoundError) { res.status(404).json({ error: { code: 'not_found', message: error.message } }); return; }
  if (error instanceof ScheduledJobConflictError || error instanceof Error && /revision|config changed|already exists/.test(error.message)) {
    res.status(409).json({ error: { code: 'conflict', message: error.message } }); return;
  }
  if (error instanceof JobValidationError) { res.status(400).json({ error: { code: 'invalid', message: error.message } }); return; }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unable to complete maintenance request' } });
}

/** Workspace-scoped maintenance controls backed by the regular Scheduled Jobs service. */
export function setupPageMaintenanceRoutes(deps: { scheduler: ScheduledJobScheduler | null; clock?: () => number }): Router {
  const router = Router();
  // Only these paths: the router is mounted at /api ahead of others, so a pathless guard would answer for all of them.
  router.use(['/workspaces/:workspaceId/maintenance', '/workspaces/:workspaceId/spaces/:spaceId/maintenance'], (_req, res, next) => deps.scheduler ? next()
    : res.status(503).json({ error: { code: 'scheduler_unavailable', message: 'Scheduled jobs are off on this backend, so Space maintenance cannot run' } }));
  const scheduler = () => deps.scheduler!;
  const configs = () => new PageMaintenanceConfigService(scheduler(), deps.clock);
  const now = () => (deps.clock ?? Date.now)();

  router.get('/workspaces/:workspaceId/maintenance', route((req, res) => {
    const workspaceId = id(req.params.workspaceId, 'workspaceId');
    const ownerUserId = owner(req);
    if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Workspace not found');
    requirePagesWorkspace(workspaceId, ownerUserId);
    requireMaintenanceNavigation(workspaceId, ownerUserId);
    res.json(getMaintenanceWorkspaceView({ workspaceId, ownerUserId, scheduler: scheduler(), now: now() }));
  }));

  router.patch('/workspaces/:workspaceId/maintenance', route((req, res) => {
    const workspaceId = id(req.params.workspaceId, 'workspaceId');
    const ownerUserId = owner(req);
    if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Workspace not found');
    requirePagesWorkspace(workspaceId, ownerUserId, true);
    requireMaintenanceNavigation(workspaceId, ownerUserId);
    const data = checkBody(req, ['expectedRevision', 'enabled', 'paused', 'runtimeId', 'providerId', 'modelId', 'reasoning']);
    for (const key of ['enabled', 'paused'] as const) if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new PageWriteError(400, 'invalid', `${key} must be boolean`);
    for (const key of ['runtimeId', 'providerId', 'modelId', 'reasoning'] as const) {
      const value = data[key];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 200)) throw new PageWriteError(400, 'invalid', `Invalid ${key}`);
    }
    const result = configs().enable({ workspaceId, ownerUserId,
      ...(data.expectedRevision === undefined ? {} : { expectedRevision: revision(data.expectedRevision) }),
      enabled: data.enabled as boolean | undefined, paused: data.paused as boolean | undefined,
      runtimeId: data.runtimeId as string | null | undefined, providerId: data.providerId as string | null | undefined,
      modelId: data.modelId as string | null | undefined, reasoning: data.reasoning as string | null | undefined,
    });
    res.json({ ...getMaintenanceWorkspaceView({ workspaceId, ownerUserId, scheduler: scheduler(), now: now() }), ...result });
  }));

  router.patch('/workspaces/:workspaceId/spaces/:spaceId/maintenance', route((req, res) => {
    const workspaceId = id(req.params.workspaceId, 'workspaceId');
    const spaceId = id(req.params.spaceId, 'spaceId');
    const ownerUserId = owner(req);
    if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Workspace not found');
    requirePagesWorkspace(workspaceId, ownerUserId, true);
    requireMaintenanceNavigation(workspaceId, ownerUserId);
    const data = checkBody(req, ['expectedRevision', 'excluded']);
    if (typeof data.excluded !== 'boolean') throw new PageWriteError(400, 'invalid', 'excluded must be boolean');
    let config = configs().get(workspaceId, ownerUserId);
    if (config) {
      if (data.expectedRevision === undefined) throw new PageWriteError(400, 'invalid', 'expectedRevision is required');
      config = setSpaceMaintenanceExcluded({ workspaceId, ownerUserId, spaceId, excluded: data.excluded,
        expectedRevision: revision(data.expectedRevision), now: now() });
    } else {
      if (data.expectedRevision !== undefined && data.expectedRevision !== 0) throw new PageWriteError(409, 'stale_revision', 'Maintenance config does not exist');
      setInitialSpaceMaintenanceExcluded({ workspaceId, ownerUserId, spaceId, excluded: data.excluded, now: now() });
    }
    res.json({ ...getMaintenanceWorkspaceView({ workspaceId, ownerUserId, scheduler: scheduler(), now: now() }), config });
  }));

  router.post('/workspaces/:workspaceId/maintenance/run', route(async (req, res) => {
    checkBody(req, []);
    const workspaceId = id(req.params.workspaceId, 'workspaceId');
    const ownerUserId = owner(req);
    requirePagesWorkspace(workspaceId, ownerUserId, true);
    requireMaintenanceNavigation(workspaceId, ownerUserId);
    const config = configs().get(workspaceId, ownerUserId);
    if (!config) throw new PageWriteError(404, 'not_found', 'Maintenance is not configured');
    if (!config.enabled || config.paused) throw new PageWriteError(409, 'stale_revision', 'Maintenance is paused');
    const result = scheduler().startNow(config.jobId);
    if ('run' in result) { res.status(202).json({ run: result.run }); return; }
    if (result.refused === 'no_work') { res.json({ run: null }); return; }
    if (result.refused === 'capacity') { scheduler().wakeJobs([config.jobId]); res.status(202).json({ run: null }); return; }
    throw new PageWriteError(409, 'stale_revision', result.message);
  }));

  router.post('/workspaces/:workspaceId/maintenance/plans/:planId/reconsider', route((req, res) => {
    const workspaceId = id(req.params.workspaceId, 'workspaceId');
    const planId = id(req.params.planId, 'planId');
    const ownerUserId = owner(req);
    requirePagesWorkspace(workspaceId, ownerUserId, true);
    requireMaintenanceNavigation(workspaceId, ownerUserId);
    const data = checkBody(req, ['expectedRevision', 'sourceTurnIds']);
    if (!Array.isArray(data.sourceTurnIds) || !data.sourceTurnIds.length || data.sourceTurnIds.length > 100
      || data.sourceTurnIds.some((turnId) => typeof turnId !== 'string' || !turnId || turnId.length > 200)) {
      throw new PageWriteError(400, 'invalid', 'sourceTurnIds must contain 1-100 turn IDs');
    }
    const queued = queueMaintenanceReconsider({ workspaceId, ownerUserId, previousPlanId: planId,
      sourceTurnIds: data.sourceTurnIds as string[], expectedConfigRevision: revision(data.expectedRevision), now: now() });
    res.status(202).json(queued);
  }));

  router.post('/workspaces/:workspaceId/maintenance/catch-up', route((req, res) => {
    const workspaceId = id(req.params.workspaceId, 'workspaceId');
    const ownerUserId = owner(req);
    requirePagesWorkspace(workspaceId, ownerUserId, true);
    requireMaintenanceNavigation(workspaceId, ownerUserId);
    const data = checkBody(req, ['expectedRevision', 'after', 'through', 'spaceId']);
    const spaceId = id(data.spaceId, 'spaceId');
    for (const key of ['after', 'through'] as const) {
      if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) throw new PageWriteError(400, 'invalid', `${key} must be a non-negative integer`);
    }
    if ((data.through as number) < (data.after as number)) throw new PageWriteError(400, 'invalid', 'through must be greater than or equal to after');
    const queued = queueMaintenanceCatchup({ workspaceId, ownerUserId, spaceId,
      expectedConfigRevision: revision(data.expectedRevision), after: data.after as number, through: data.through as number, now: now() });
    res.status(202).json(queued);
  }));

  router.use(errors);
  return router;
}
