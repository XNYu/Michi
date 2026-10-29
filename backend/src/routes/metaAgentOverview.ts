import { readMetaAgentMetrics } from '../services/metaAgentMetrics';
import { Router, type Request, type Response } from 'express';
import { localOnlyGuard } from './middleware/localOnly';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { log } from '../services/logger';
import { MetaAgentPauseError, metaAgentOverview, setMetaAgentPaused } from '../services/metaAgent/overview';
import { PageWriteError } from '../services/pages/core';
import type { ScheduledJobScheduler } from '../services/scheduledJobs/scheduler';

const metaAgentLocalOnly = localOnlyGuard('The Meta agent requires local or authenticated remote access', { allowAuthenticatedRemote: true });

/**
 * Scheduled › Meta agent (services/metaAgent/overview.ts). Mounted
 * beside routes/metaAgent.ts for local and authenticated remote access, never in cloud mode.
 *
 *   GET  /api/meta-agent/overview → MetaAgentOverview
 *   POST /api/meta-agent/pause    → MetaAgentOverview (every workspace's maintenance paused)
 *   POST /api/meta-agent/resume   → MetaAgentOverview
 */
export function setupMetaAgentOverviewRoutes(deps: { scheduler: ScheduledJobScheduler | null; clock?: () => number }): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();
  const overview = async () => {
    const at = now();
    const metrics = await readMetaAgentMetrics(LOCAL_AGENT_OWNER_ID, at);
    return metaAgentOverview({ ownerUserId: LOCAL_AGENT_OWNER_ID, now: at, today: metrics.today });
  };
  for (const path of ['/meta-agent/overview', '/meta-agent/pause', '/meta-agent/resume']) router.use(path, ...metaAgentLocalOnly);

  const fail = (res: Response, err: unknown, what: string) => {
    if (err instanceof MetaAgentPauseError) { res.status(409).json({ error: err.message }); return; }
    if (err instanceof PageWriteError) { res.status(err.status).json({ error: err.message }); return; }
    log.warn('http', `meta agent ${what} failed`, { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'The Meta agent overview is not available' });
  };

  router.get('/meta-agent/overview', async (_req, res) => {
    try {
      res.json(await overview());
    } catch (err) {
      fail(res, err, 'overview');
    }
  });

  const toggle = (paused: boolean) => async (req: Request, res: Response) => {
    if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Object.keys(req.body).length > 0)) {
      res.status(400).json({ error: 'This request takes no body' });
      return;
    }
    if (!deps.scheduler) { res.status(404).json({ error: 'Scheduled jobs are unavailable' }); return; }
    try {
      setMetaAgentPaused({ scheduler: deps.scheduler, ownerUserId: LOCAL_AGENT_OWNER_ID, paused, clock: deps.clock });
      res.json(await overview());
    } catch (err) {
      fail(res, err, paused ? 'pause' : 'resume');
    }
  };
  router.post('/meta-agent/pause', toggle(true));
  router.post('/meta-agent/resume', toggle(false));

  return router;
}
