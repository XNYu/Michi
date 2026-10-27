import { Router, type NextFunction, type Request, type Response } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { log } from '../services/logger';
import { metaAgentRoundStatus, runMetaAgentRoundNow } from '../services/metaAgent/runNow';
import type { ScheduledJobScheduler } from '../services/scheduledJobs/scheduler';
import { requireLocalControlRequest } from './middleware/localControl';

const owner = (req: Request): string => process.env.MICHI_CLOUD === '1'
  ? (req as Request & { user?: { id?: string } }).user?.id ?? ''
  : LOCAL_AGENT_OWNER_ID;

const fail = (res: Response, status: number, code: string, message: string) => { res.status(status).json({ error: { code, message } }); };

/**
 * The Spaces Home's Update button (services/metaAgent/runNow.ts). Mounted on
 * every backend, before the local-only /meta-agent routes, so a remote
 * connection's own Meta agent answers through the connection proxy.
 *
 *   POST /api/meta-agent/run-now → MetaAgentRunNowResponse
 *   GET  /api/meta-agent/run-now → MetaAgentRoundStatus
 */
export function setupMetaAgentRunNowRoutes(deps: { scheduler: ScheduledJobScheduler | null; clock?: () => number }): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();
  router.use('/meta-agent/run-now', requireLocalControlRequest, (req: Request, res: Response, next: NextFunction) => {
    if (!deps.scheduler) { fail(res, 503, 'scheduler_unavailable', 'Scheduled jobs are off on this backend, so the Meta agent cannot run'); return; }
    if (!owner(req)) { fail(res, 404, 'not_found', 'Meta agent not found'); return; }
    next();
  });

  router.post('/meta-agent/run-now', (req, res) => {
    if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
      fail(res, 400, 'invalid', 'This request takes no body');
      return;
    }
    try {
      res.json(runMetaAgentRoundNow({ scheduler: deps.scheduler!, ownerUserId: owner(req) }));
    } catch (err) {
      log.warn('http', 'meta agent run-now failed', { err: err instanceof Error ? err.message : String(err) });
      fail(res, 500, 'internal_error', 'Could not start the Meta agent');
    }
  });

  router.get('/meta-agent/run-now', (req, res) => {
    try {
      res.json(metaAgentRoundStatus({ scheduler: deps.scheduler!, ownerUserId: owner(req), now: now() }));
    } catch (err) {
      log.warn('http', 'meta agent round status failed', { err: err instanceof Error ? err.message : String(err) });
      fail(res, 500, 'internal_error', 'Could not read the Meta agent round');
    }
  });

  return router;
}
