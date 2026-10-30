import express from 'express';
import type { MobileAccessProvider } from 'michi-shared';
import type { MobileAccessController } from '../services/mobileAccessManager';
import { requireLocalControlRequest } from './middleware/localControl';

/** `remember` records the owner's Settings choice. Shutdown stops access
 * through the service directly, so it never clears that choice. */
export function setupMobileAccessRoutes(access: MobileAccessController, options: { remember?: (enabled: boolean, provider?: MobileAccessProvider) => void } = {}): express.Router {
  const router = express.Router();
  router.use('/mobile-access', requireLocalControlRequest, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/mobile-access', async (_req, res) => { res.json(await access.status()); });
  router.post('/mobile-access/start', async (_req, res) => {
    let status;
    try { status = await access.start(); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); return; }
    options.remember?.(['starting', 'connected', 'reconnecting'].includes(status.state), status.provider);
    res.json(status);
  });
  router.post('/mobile-access/stop', async (_req, res) => {
    const status = await access.stop();
    options.remember?.(false, status.provider);
    res.json(status);
  });
  router.post('/mobile-access/link', (_req, res) => {
    try { res.json(access.link()); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  router.post('/mobile-access/provider', async (req, res) => {
    const provider = req.body?.provider;
    if (provider !== 'tailscale' || !access.select) {
      res.status(400).json({ error: 'Choose a supported phone access method.' }); return;
    }
    try {
      const status = await access.select(provider);
      options.remember?.(['starting', 'connected', 'reconnecting'].includes(status.state), status.provider);
      res.json(status);
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  for (const action of ['login', 'open-app'] as const) router.post(`/mobile-access/${action}`, async (_req, res) => {
    try {
      const operation = action === 'login' ? access.login : access.openApp;
      if (!operation) throw new Error('Update this Michi backend to connect Tailscale.');
      res.json(await operation.call(access));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  return router;
}
