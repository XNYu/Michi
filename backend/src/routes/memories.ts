import express, { type Request, type Response } from 'express';
import type { MemoryErrorResponse, MemoryStatus } from 'michi-shared';
import { createSseObserver } from '../services/httpSse';
import { log } from '../services/logger';
import { subscribeMemoryChanges } from '../services/memory/memoryChangeFeed';
import { memoryOwnerId } from '../services/memory/memoryOwner';
import {
  MemoryError,
  approveMemory,
  createMemory,
  deleteMemory,
  getMemorySettings,
  listMemories,
  rejectMemory,
  setMemorySettings,
  updateMemory,
  type MemoryCaller,
} from '../services/memory/memoryService';
import { requireRequestAccess } from './middleware/sessionAccess';

/**
 * Michi Memory REST API (C2), used by Settings → Memory. The owner is the
 * session's user in cloud mode and the local identity on the desktop, as for
 * the other owner-scoped routes; no request field can name another owner.
 * Another owner's memory or workspace answers 404, like a missing one.
 */

class RequestError extends Error {}

const STATUS_FOR_CODE: Record<MemoryError['code'], number> = {
  invalid_argument: 400,
  not_found: 404,
  version_conflict: 409,
  invalid_state: 409,
  memory_disabled: 409,
};

function caller(req: Request): MemoryCaller | null {
  const ownerUserId = memoryOwnerId(req.user?.id);
  return ownerUserId ? { ownerUserId } : null;
}

function route(fn: (req: Request, res: Response, caller: MemoryCaller) => void) {
  return (req: Request, res: Response): void => {
    const who = caller(req);
    if (!who) {
      const body: MemoryErrorResponse = { error: 'unauthorized', code: 'unauthorized' };
      res.status(401).json(body);
      return;
    }
    try {
      fn(req, res, who);
    } catch (error) {
      if (error instanceof MemoryError || error instanceof RequestError) {
        const code = error instanceof MemoryError ? error.code : 'invalid_argument';
        const body: MemoryErrorResponse = { error: error.message, code };
        if (error instanceof MemoryError && error.currentVersion !== undefined) body.currentVersion = error.currentVersion;
        res.status(STATUS_FOR_CODE[code]).json(body);
        return;
      }
      log.error('workspace', 'memory request failed', { method: req.method, path: req.path, error: (error as Error).message });
      res.status(500).json({ error: 'Memory request failed' });
    }
  };
}

/** A JSON object body holding only `allowed` keys. */
function jsonBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RequestError('Request body must be a JSON object');
  const unknownKey = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknownKey) throw new RequestError(`Unsupported field: ${unknownKey}`);
  return body as Record<string, unknown>;
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestError(`${name} must be given once`);
  return value.trim() || undefined;
}

/** status=active,pending or status=active&status=pending */
function queryStatuses(req: Request): MemoryStatus[] | undefined {
  const raw = req.query.status;
  if (raw === undefined) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    if (typeof value !== 'string') throw new RequestError('status is invalid');
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  });
  return values.length > 0 ? values as MemoryStatus[] : undefined;
}

function queryLimit(req: Request): number | undefined {
  const raw = queryString(req, 'limit');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new RequestError('limit must be a positive integer');
  return Number(raw);
}

function memoryIdParam(req: Request): string {
  return String(req.params.id ?? '');
}

const CHANGE_STREAM_KEEPALIVE_MS = 25_000;

export function setupMemoryRoutes(): express.Router {
  const router = express.Router();
  router.use(['/memories', '/memory-settings'], requireRequestAccess);

  /**
   * Persistent SSE feed of the caller's memory changes (C4), one
   * `memory_changed` frame per MemoryChangedEvent. Only the caller's own
   * changes are sent; closing the response only detaches this subscriber.
   */
  router.get('/memories/changes/stream', (req, res) => {
    const who = caller(req);
    if (!who) {
      const body: MemoryErrorResponse = { error: 'unauthorized', code: 'unauthorized' };
      res.status(401).json(body);
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const observer = createSseObserver(res);
    if (!observer.write(': connected\n\n')) return;
    observer.addCleanup(subscribeMemoryChanges(who.ownerUserId, (event) => {
      observer.write(`event: memory_changed\ndata: ${JSON.stringify(event)}\n\n`);
    }));
    observer.heartbeat(': keepalive\n\n', CHANGE_STREAM_KEEPALIVE_MS);
  });

  router.get('/memories', route((req, res, who) => {
    const scope = queryString(req, 'scope');
    if (scope !== undefined && scope !== 'user' && scope !== 'workspace') throw new RequestError('scope must be user or workspace');
    res.json(listMemories(who, {
      scope,
      workspaceId: queryString(req, 'workspaceId'),
      status: queryStatuses(req),
      query: queryString(req, 'q'),
      cursor: queryString(req, 'cursor'),
      limit: queryLimit(req),
    }));
  }));

  // Added by hand in Settings: always explicit and active.
  router.post('/memories', route((req, res, who) => {
    const body = jsonBody(req, ['scope', 'kind', 'body']);
    const memory = createMemory(who, {
      scope: body.scope as never,
      kind: body.kind as never,
      body: body.body as string,
      status: 'active',
      origin: 'explicit',
    });
    res.status(201).json({ memory });
  }));

  router.patch('/memories/:id', route((req, res, who) => {
    const body = jsonBody(req, ['body', 'scope', 'kind', 'expectedVersion']);
    if (typeof body.expectedVersion !== 'number') throw new RequestError('expectedVersion is required');
    const memory = updateMemory(who, memoryIdParam(req), {
      ...(body.body !== undefined ? { body: body.body as string } : {}),
      ...(body.scope !== undefined ? { scope: body.scope as never } : {}),
      ...(body.kind !== undefined ? { kind: body.kind as never } : {}),
    }, body.expectedVersion);
    res.json({ memory });
  }));

  router.delete('/memories/:id', route((req, res, who) => {
    deleteMemory(who, memoryIdParam(req));
    res.status(204).end();
  }));

  router.post('/memories/:id/approve', route((req, res, who) => {
    res.json({ memory: approveMemory(who, memoryIdParam(req)) });
  }));

  router.post('/memories/:id/reject', route((req, res, who) => {
    rejectMemory(who, memoryIdParam(req));
    res.status(204).end();
  }));

  router.get('/memory-settings', route((_req, res, who) => {
    res.json(getMemorySettings(who.ownerUserId));
  }));

  router.put('/memory-settings', route((req, res, who) => {
    const body = jsonBody(req, ['mode']);
    setMemorySettings(who.ownerUserId, { mode: body.mode as never });
    res.json(getMemorySettings(who.ownerUserId));
  }));

  return router;
}
