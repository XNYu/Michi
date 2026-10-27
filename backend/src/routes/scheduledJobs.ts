import { getScheduledJobSettings, updateScheduledJobSettings } from '../services/scheduledJobs/settings';
import { createSseObserver } from '../services/httpSse';
import { Router, type Request, type Response } from 'express';
import { requireLocalControlRequest } from './middleware/localControl';
import { encodeScheduledJobEvent, type ScheduledJobEventBus } from '../services/scheduledJobs/events';
import {
  JobValidationError,
  ScheduledJobConflictError,
  ScheduledJobNotFoundError,
  type ScheduledJobScheduler,
} from '../services/scheduledJobs/scheduler';
import { log } from '../services/logger';

const KEEPALIVE_MS = 15_000;

function errorStatus(error: unknown): number {
  if (error instanceof ScheduledJobNotFoundError) return 404;
  if (error instanceof ScheduledJobConflictError) return 409;
  if (error instanceof JobValidationError) return 400;
  return 500;
}

function handle(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) {
        log.error('scheduler', 'scheduled job request failed', { path: req.path, error: (error as Error).message });
      }
      if (!res.headersSent) {
        res.status(status).json({ error: status === 500 ? 'Scheduled job request failed' : (error as Error).message });
      }
    }
  };
}

const encodeEvent = encodeScheduledJobEvent;

/**
 * Scheduled Jobs API. Desktop-only: every route requires a loopback request
 * from the local renderer (or a process without an Origin, such as Electron
 * main), because a job runs agent prompts unattended.
 */
export function setupScheduledJobRoutes(deps: {
  scheduler: ScheduledJobScheduler | null;
  events: ScheduledJobEventBus;
}): Router {
  const router = Router();
  router.use('/scheduled-jobs', (req, res, next) => {
    if (!deps.scheduler) {
      res.status(404).json({ error: 'Scheduled jobs are not available on this server' });
      return;
    }
    next();
  }, requireLocalControlRequest);
  const scheduler = () => deps.scheduler!;

  router.get('/scheduled-jobs/settings', handle((_req, res) => {
    res.json(getScheduledJobSettings());
  }));

  router.patch('/scheduled-jobs/settings', handle((req, res) => {
    res.json(updateScheduledJobSettings(req.body));
  }));

  router.get('/scheduled-jobs', handle((_req, res) => {
    res.json({ jobs: scheduler().listJobs(), scheduler: scheduler().status() });
  }));

  router.post('/scheduled-jobs', handle((req, res) => {
    res.status(201).json(scheduler().createJob(req.body));
  }));

  router.post('/scheduled-jobs/preview', handle((req, res) => {
    res.json(scheduler().preview(req.body?.schedule));
  }));

  /**
   * Desktop notification feed for the Electron main process. Replays
   * undelivered notifications on connect; the client acknowledges each one.
   */
  router.get('/scheduled-jobs/notifications/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const observer = createSseObserver(res);
    for (const event of scheduler().pendingNotifications()) {
      if (!observer.write(encodeEvent(event))) return;
    }
    observer.addCleanup(deps.events.subscribe({
      notifier: true,
      send: (event) => {
        if (event.phase !== 'started') observer.write(encodeEvent(event));
      },
    }));
    observer.heartbeat(': keepalive\n\n', KEEPALIVE_MS);
  });

  router.post('/scheduled-jobs/runs/:runId/notified', handle((req, res) => {
    res.json({ acknowledged: scheduler().acknowledgeNotification(String(req.params.runId)) });
  }));

  router.post('/scheduled-jobs/executions/:runId/confirm-stopped', handle((req, res) => {
    scheduler().confirmExecutionStopped(String(req.params.runId), req.body);
    res.json({ released: true });
  }));

  router.get('/scheduled-jobs/runs/:runId', handle((req, res) => {
    res.json(scheduler().getRun(String(req.params.runId)));
  }));

  router.get('/scheduled-jobs/:id', handle((req, res) => {
    res.json(scheduler().getJob(String(req.params.id)));
  }));

  router.patch('/scheduled-jobs/:id', handle((req, res) => {
    res.json(scheduler().updateJob(String(req.params.id), req.body));
  }));

  router.delete('/scheduled-jobs/:id', handle((req, res) => {
    scheduler().deleteJob(String(req.params.id));
    res.status(204).end();
  }));

  router.get('/scheduled-jobs/:id/runs', handle((req, res) => {
    res.json({ runs: scheduler().listRuns(String(req.params.id)) });
  }));

  router.post('/scheduled-jobs/:id/run', handle(async (req, res) => {
    res.status(202).json(await scheduler().runNow(String(req.params.id)));
  }));

  router.post('/scheduled-jobs/:id/cancel', handle((req, res) => {
    res.json({ cancelled: scheduler().cancelActiveRun(String(req.params.id)) });
  }));

  return router;
}
