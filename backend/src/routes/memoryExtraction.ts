import express, { type Request, type Response } from 'express';
import type { MemoryErrorResponse } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { log } from '../services/logger';
import {
  cancelMemoryExtraction, memoryExtractionStatus, setMemoryExtractionPaused, type MemoryExtractionScheduler,
} from '../services/memory/extractionService';
import { MemoryError } from '../services/memory/memoryService';
import { requireRequestAccess } from './middleware/sessionAccess';

/**
 * Automatic memory status and controls (C5), used by Settings → Memory. The
 * owner comes from the session exactly as in routes/memories.ts; a request
 * can name only one of the owner's own workspaces. Extraction itself runs in
 * the scheduler, which is absent on cloud backends: status then reports
 * supported false and cancel finds nothing to stop.
 */

class RequestError extends Error {}

function ownerOf(req: Request): string | null {
  const ownerUserId = process.env.MICHI_CLOUD === '1' ? req.user?.id?.trim() ?? '' : LOCAL_AGENT_OWNER_ID;
  return ownerUserId || null;
}

/** An optional { workspaceId } body and nothing else. */
function workspaceIdOf(req: Request): string | undefined {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RequestError('Request body must be a JSON object');
  const unknownKey = Object.keys(body).find((key) => key !== 'workspaceId');
  if (unknownKey) throw new RequestError(`Unsupported field: ${unknownKey}`);
  const { workspaceId } = body as { workspaceId?: unknown };
  if (workspaceId === undefined) return undefined;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new RequestError('workspaceId must be a non-empty string');
  return workspaceId;
}

export function setupMemoryExtractionRoutes(deps: { scheduler: MemoryExtractionScheduler | null }): express.Router {
  const router = express.Router();
  router.use('/memory-extraction', requireRequestAccess);

  const route = (fn: (req: Request, ownerUserId: string) => void) => (req: Request, res: Response): void => {
    const ownerUserId = ownerOf(req);
    if (!ownerUserId) {
      const body: MemoryErrorResponse = { error: 'unauthorized', code: 'unauthorized' };
      res.status(401).json(body);
      return;
    }
    try {
      fn(req, ownerUserId);
      res.json(memoryExtractionStatus(ownerUserId, Date.now(), deps.scheduler));
    } catch (error) {
      if (error instanceof RequestError || error instanceof MemoryError) {
        const code = error instanceof MemoryError ? error.code : 'invalid_argument';
        const body: MemoryErrorResponse = { error: error.message, code };
        res.status(code === 'not_found' ? 404 : 400).json(body);
        return;
      }
      log.error('workspace', 'memory extraction request failed', { method: req.method, path: req.path, error: (error as Error).message });
      res.status(500).json({ error: 'Memory extraction request failed' });
    }
  };

  router.get('/memory-extraction/status', route(() => {}));
  router.post('/memory-extraction/pause', route((req, ownerUserId) => {
    setMemoryExtractionPaused({ ownerUserId, workspaceId: workspaceIdOf(req), paused: true, now: Date.now(), scheduler: deps.scheduler });
  }));
  router.post('/memory-extraction/resume', route((req, ownerUserId) => {
    setMemoryExtractionPaused({ ownerUserId, workspaceId: workspaceIdOf(req), paused: false, now: Date.now(), scheduler: deps.scheduler });
  }));
  // Stops a running execution now (pause lets it finish its batch); it is recorded as cancelled and saves nothing.
  router.post('/memory-extraction/cancel', route((req, ownerUserId) => {
    const workspaceId = workspaceIdOf(req);
    if (deps.scheduler) cancelMemoryExtraction(ownerUserId, deps.scheduler, workspaceId);
  }));

  return router;
}
