import express from 'express';
import { SelfUpdateError, type SelfUpdater } from '../services/selfUpdate';
import { requireLocalControlRequest } from './middleware/localControl';
import { log } from '../services/logger';

/**
 * Settings → Update on a phone: this backend checks its source branch and
 * replaces itself with the latest build. The owner reaches it through the
 * desktop's authenticated proxy or phone access (both carry the remote
 * token); the source comes from this machine's environment, never the request.
 */
export function setupSelfUpdateRoutes(updater: SelfUpdater): express.Router {
  const router = express.Router();
  router.use('/self-update', requireLocalControlRequest, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const fail = (res: express.Response, error: unknown) => {
    if (error instanceof SelfUpdateError) { res.status(error.status).json({ error: error.message, ...error.body }); return; }
    log.warn('http', 'self-update request failed', { error: (error as Error).message });
    res.status(500).json({ error: (error as Error).message || 'The update could not run.' });
  };
  router.get('/self-update', (_req, res) => { res.json(updater.status()); });
  router.post('/self-update/check', async (_req, res) => {
    try { res.json(await updater.check()); } catch (error) { fail(res, error); }
  });
  router.post('/self-update/start', async (req, res) => {
    const revision = req.body?.revision;
    if (revision !== undefined && (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision))) {
      res.status(400).json({ error: 'revision must be a full commit hash' });
      return;
    }
    try {
      const job = await updater.start(revision);
      log.info('http', 'self-update started', { id: job.id, from: job.from, target: job.target });
      res.status(202).json({ job });
    } catch (error) { fail(res, error); }
  });
  return router;
}
