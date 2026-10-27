import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isLoopbackAddress } from '../../services/remoteAccess';
import { allowedHostNames, isAllowedLocalHost, isAllowedLocalOrigin } from '../../services/localOrigins';

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

/**
 * A browser Origin Michi's own renderer can have. The rule is
 * isAllowedLocalOrigin (services/localOrigins.ts), the same one the API's
 * CORS and origin guard apply: the backend's own origin, the dev renderers
 * and the configured origins. Requests without an Origin (CLI tools,
 * runtimes, Electron main) pass.
 */
export function isTrustedRendererOrigin(req: { headers: IncomingHttpHeaders }, origin: string | undefined): boolean {
  return isAllowedLocalOrigin(origin, req.headers.host);
}

/** True when the Host header names this machine's loopback interface. */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return isLocalHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function isLoopbackListenHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** True when the request comes from this machine's own app (or an authenticated remote session). */
export function isLocalControlRequest(req: Request, res: Response): boolean {
  if (res.locals.remoteAccessAuthenticated === true) return true;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  return isLoopbackAddress(req.socket.remoteAddress) && isTrustedRendererOrigin(req, origin);
}

export function requireLocalControlRequest(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalControlRequest(req, res)) {
    res.status(403).json({ ok: false, error: 'This action is only available from the local Michi app' });
    return;
  }
  next();
}

/**
 * Desktop API guard on /api, behind installLocalAccessGuards (which server.ts
 * mounts before every route) and the remote-access token check. The loopback
 * API has no user authentication, so it must not be usable by arbitrary web
 * pages the user happens to visit:
 *  - a browser request carrying a foreign Origin is rejected (CSRF / reads);
 *  - a cross-site request without an Origin (e.g. an <img> GET) is rejected;
 *  - when bound to loopback, a Host that is not loopback, an IP address or in
 *    MICHI_ALLOWED_HOSTS is rejected (DNS rebinding).
 * Requests authenticated by the remote-access bearer token are not affected.
 */
export function createLocalOriginGuard(options: { loopbackListener: boolean }): RequestHandler {
  return (req, res, next) => {
    if (res.locals.remoteAccessAuthenticated === true) return next();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (origin !== undefined) {
      if (!isTrustedRendererOrigin(req, origin)) {
        res.status(403).json({ error: 'Request origin is not allowed' });
        return;
      }
    } else if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({ error: 'Cross-site request is not allowed' });
      return;
    }
    // The Host rule of services/localOrigins.ts (loopback names, IP
    // literals, MICHI_ALLOWED_HOSTS), so the two guards cannot disagree.
    if (options.loopbackListener && !isAllowedLocalHost(req.headers.host, allowedHostNames())) {
      res.status(403).json({ error: 'Request host is not allowed' });
      return;
    }
    next();
  };
}
