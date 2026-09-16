import type { NextFunction, Request, Response } from 'express';
import { isLoopbackAddress } from '../../services/remoteAccess';

const DEFAULT_RENDERER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]);

function configuredRendererOrigins(): Set<string> {
  const values = [
    process.env.MICHI_RENDERER_URL,
    ...(process.env.MICHI_LOCAL_CONTROL_ORIGINS ?? '').split(','),
  ];
  const origins = new Set(DEFAULT_RENDERER_ORIGINS);
  for (const value of values) {
    if (!value?.trim()) continue;
    try { origins.add(new URL(value.trim()).origin); } catch { /* invalid config is ignored */ }
  }
  return origins;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

function isTrustedRendererOrigin(req: Request, origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const url = new URL(origin);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLocalHostname(url.hostname)) {
      return false;
    }
    const requestHost = req.headers.host;
    if (requestHost) {
      const requestUrl = new URL(`http://${requestHost}`);
      if (isLocalHostname(requestUrl.hostname) && requestUrl.port === url.port) return true;
    }
    return configuredRendererOrigins().has(url.origin);
  } catch {
    return false;
  }
}

export function requireLocalControlRequest(req: Request, res: Response, next: NextFunction): void {
  if (res.locals.remoteAccessAuthenticated === true) {
    next();
    return;
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isTrustedRendererOrigin(req, origin)) {
    res.status(403).json({ ok: false, error: 'Custom Agents can only be configured from the local Michi app' });
    return;
  }
  next();
}
