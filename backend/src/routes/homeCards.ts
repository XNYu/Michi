import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { localOnlyGuard } from './middleware/localOnly';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { HomeCardsError, markHomeCardUsed, parseHomeCardsWrite, readHomeCards, writeHomeCards } from '../services/homeCards/repository';

/** Only the Meta agent on this machine writes the cards. */
const writerLocalOnly = localOnlyGuard('Home cards are written by the local Meta agent only');

const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;

function route(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch(next);
  };
}

function noQuery(req: Request): void {
  if (Object.keys(req.query).length > 0) throw new HomeCardsError(400, 'invalid', 'Unknown query parameter');
}

function errors(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HomeCardsError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unable to complete Home cards request' } });
}

export interface HomeCardsRouteDeps {
  clock?: () => number;
}

/**
 * Michi Home inspiration cards, per owner. Mount at /api.
 *
 *   GET  /home/cards               -> HomeCardsDto
 *   PUT  /home/cards               HomeCardsWrite -> HomeCardsDto (local-only)
 *   POST /home/cards/:cardId/used  -> HomeCardUsedDto
 */
export function setupHomeCardsRoutes(deps: HomeCardsRouteDeps = {}): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();

  router.get('/home/cards', route((req, res) => {
    noQuery(req);
    res.json(readHomeCards(owner(req)));
  }));
  router.put('/home/cards', ...writerLocalOnly, route((req, res) => {
    noQuery(req);
    res.json(writeHomeCards(owner(req), parseHomeCardsWrite(req.body), now()));
  }));
  router.post('/home/cards/:cardId/used', route((req, res) => {
    noQuery(req);
    const cardId = req.params.cardId;
    if (typeof cardId !== 'string' || !cardId || cardId.length > 200) throw new HomeCardsError(400, 'invalid', 'Invalid cardId');
    res.json(markHomeCardUsed(owner(req), cardId, now()));
  }));

  router.use('/home/cards', errors);
  return router;
}
