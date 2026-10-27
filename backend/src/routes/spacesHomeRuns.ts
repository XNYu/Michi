import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { SpacesFirstRunStatus } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError } from '../services/pages/core';
import type { ScheduledJobScheduler } from '../services/scheduledJobs/scheduler';
import { retrySpacesFirstRun, spacesFirstRunStatus, startSpacesFirstRun } from '../services/metaAgent/firstRun';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const owner = (req: Request): string => process.env.MICHI_CLOUD === '1'
  ? (req as Request & { user?: { id?: string } }).user?.id ?? ''
  : LOCAL_AGENT_OWNER_ID;

function requireOwner(req: Request): string {
  const ownerUserId = owner(req);
  if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Spaces Home not found');
  return ownerUserId;
}

function body(req: Request, keys: readonly string[]): Obj {
  if (req.body === undefined || (isObject(req.body) && Object.keys(req.body).length === 0)) return {};
  if (!isObject(req.body) || !Object.keys(req.body).every((key) => keys.includes(key))) throw new PageWriteError(400, 'invalid', 'Invalid request body');
  return req.body;
}

/** Every answer is the shared SpacesFirstRunStatus the client reads. */
const answer = (res: Response, status: SpacesFirstRunStatus) => { res.json(status); };

function route(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
}

function errors(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof PageWriteError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unable to complete the Spaces first-run request' } });
}

/**
 * First-time generation of the workspace homes and the Spaces Home. Mount at /api.
 *   POST /spaces-home/first-run        -> SpacesFirstRunStatus (idempotent; call whenever Spaces opens)
 *   GET  /spaces-home/first-run        -> SpacesFirstRunStatus
 *   POST /spaces-home/first-run/retry  { workspaceId? } -> SpacesFirstRunStatus (failed runs only)
 */
export function setupSpacesHomeRunRoutes(deps: { scheduler: ScheduledJobScheduler | null; clock?: () => number }): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();
  const scheduler = (): ScheduledJobScheduler => {
    if (!deps.scheduler) throw new PageWriteError(409, 'invalid', 'The Meta agent needs scheduled jobs, which are off on this backend');
    return deps.scheduler;
  };

  router.get('/spaces-home/first-run', route((req, res) => {
    answer(res, spacesFirstRunStatus(requireOwner(req), now()));
  }));

  router.post('/spaces-home/first-run', route((req, res) => {
    body(req, []);
    answer(res, startSpacesFirstRun(scheduler(), requireOwner(req), now()));
  }));

  router.post('/spaces-home/first-run/retry', route((req, res) => {
    const input = body(req, ['workspaceId']);
    if (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200)) {
      throw new PageWriteError(400, 'invalid', 'Invalid workspaceId');
    }
    answer(res, retrySpacesFirstRun(scheduler(), requireOwner(req), (input.workspaceId as string | undefined) ?? null, now()));
  }));

  router.use('/spaces-home/first-run', errors);
  return router;
}
