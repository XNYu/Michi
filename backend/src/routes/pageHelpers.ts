import { Router, type NextFunction, type Request, type Response } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError } from '../services/pages/core';
import { ensurePageHelper, promotePageHelper } from '../services/pages/helpers';

const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;

function pageId(req: Request): string {
  const value = req.params.pageId;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new PageWriteError(400, 'invalid', 'Invalid pageId');
  }
  return value;
}

function endpoint(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try { fn(req, res); } catch (error) { next(error); }
  };
}

function handleError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof PageWriteError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unable to complete page helper request' } });
}

/** Page helper lifecycle endpoints. Caller identity always comes from authenticated middleware. */
export function setupPageHelperRoutes(): Router {
  const router = Router();
  router.post('/pages/:pageId/helper', endpoint((req, res) => {
    res.json(ensurePageHelper(pageId(req), owner(req)));
  }));
  router.post('/pages/:pageId/helper/promote', endpoint((req, res) => {
    res.json(promotePageHelper(pageId(req), owner(req)));
  }));
  router.use(handleError);
  return router;
}
