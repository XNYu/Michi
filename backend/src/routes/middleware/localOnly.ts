import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isLocalControlRequest } from './localControl';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function loopbackHost(req: Request): boolean {
  let hostname = '';
  try {
    hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
  } catch {
    // Unparseable Host header: not loopback.
  }
  return LOCAL_HOSTNAMES.has(hostname);
}

/**
 * The middleware pair for routes only this machine's own app may reach:
 * refuse hosts that are not loopback names (DNS rebinding), then requests
 * the local-control check refuses. Both answer 403 with `message` (the
 * shared middleware's own text is about Custom Agents). Mount in this order.
 */
export function localOnlyGuard(message: string): readonly [RequestHandler, RequestHandler] {
  const host = (req: Request, res: Response, next: NextFunction): void => {
    if (!loopbackHost(req)) {
      res.status(403).json({ error: message });
      return;
    }
    next();
  };
  const control = (req: Request, res: Response, next: NextFunction): void => {
    if (!isLocalControlRequest(req, res)) {
      res.status(403).json({ error: message });
      return;
    }
    next();
  };
  return [host, control] as const;
}
