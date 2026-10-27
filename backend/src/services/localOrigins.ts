import cors from 'cors';
import type { Express, RequestHandler } from 'express';
import { isIP } from 'node:net';
import { log } from './logger';

/**
 * Who may talk to the API when auth is off (desktop, `npm run dev`, remote
 * access with its bearer token). Without a session, a web page the user
 * happens to visit could otherwise reach http://127.0.0.1:<port>: read
 * chats through CORS, run a handler with a simple (unpreflighted) request,
 * or rebind its own host name to 127.0.0.1 and become same-origin.
 *
 * Origins (isAllowedLocalOrigin), for both CORS and the request guard:
 * - no Origin: curl, agent CLIs, server-side proxies, same-origin GETs,
 *   `<img>` loads;
 * - the backend's own host (Michi's UI served by this backend), counting
 *   localhost / 127.0.0.1 / [::1] on the same port as one host;
 * - under the dev watch build (MICHI_DEV_RENDERER=1, which only
 *   backend/scripts/build.mjs --watch sets; not NODE_ENV, which a packaged
 *   app can inherit from the user's environment), `npm run dev`'s Vite
 *   renderer on loopback :3001;
 * - MICHI_RENDERER_URL (electron-dev's random port), MICHI_CORS_ORIGINS
 *   and MICHI_LOCAL_CONTROL_ORIGINS;
 * - any loopback port only with MICHI_ALLOW_LOOPBACK_ORIGINS=1: other local
 *   servers' pages (the user's dev app in the in-app browser, a downloaded
 *   HTML file served locally) are not Michi.
 * `null` (sandboxed iframes, file://) is refused: any site can produce it.
 *
 * These are the only origin and host rules: the /api guard and the
 * local-control check in routes/middleware/localControl.ts and the
 * stream-transport ticket route apply them too.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEV_RENDERER_PORT = '3001';
/** Distinct refused origins and hosts logged per process. */
const REFUSAL_LOG_LIMIT = 50;

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function listFromEnv(...names: string[]): string[] {
  return names.flatMap((name) => (process.env[name] ?? '').split(',')).map((value) => value.trim()).filter(Boolean);
}

/** MICHI_CORS_ORIGINS, MICHI_LOCAL_CONTROL_ORIGINS and MICHI_RENDERER_URL, as origins. */
export function configuredOrigins(): string[] {
  const out = new Set<string>();
  for (const value of [...listFromEnv('MICHI_CORS_ORIGINS', 'MICHI_LOCAL_CONTROL_ORIGINS'), process.env.MICHI_RENDERER_URL?.trim() ?? '']) {
    if (!value) continue;
    try { out.add(new URL(value).origin); } catch { out.add(value); }
  }
  return [...out];
}

/** Host header → URL, or null when it is not a host[:port]. */
function hostUrl(host: string | undefined): URL | null {
  if (!host) return null;
  try { return new URL(`http://${host}`); } catch { return null; }
}

export interface LocalOriginOptions {
  /** Defaults to configuredOrigins(). */
  configured?: readonly string[];
  /** Any loopback port; defaults to MICHI_ALLOW_LOOPBACK_ORIGINS=1. */
  allowAnyLoopback?: boolean;
  /** Loopback :3001 (`npm run dev`); defaults to MICHI_DEV_RENDERER=1. */
  devRenderer?: boolean;
}

export function isAllowedLocalOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  options: LocalOriginOptions = {},
): boolean {
  if (!origin) return true;
  const configured = options.configured ?? configuredOrigins();
  if (configured.includes(origin)) return true;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = hostUrl(requestHost);
  if (host && parsed.host === host.host) return true;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  if (host && isLoopbackHostname(host.hostname) && parsed.port === host.port) return true;
  const devRenderer = options.devRenderer ?? process.env.MICHI_DEV_RENDERER === '1';
  const allowAnyLoopback = options.allowAnyLoopback ?? process.env.MICHI_ALLOW_LOOPBACK_ORIGINS === '1';
  return (devRenderer && parsed.port === DEV_RENDERER_PORT) || allowAnyLoopback;
}

/**
 * Whether a Host may reach the API: loopback names, IP literals (a
 * rebinding attack needs a DNS name; LAN access by IP keeps working) and
 * MICHI_ALLOWED_HOSTS. Requests without a Host pass (browsers always send
 * one).
 */
export function isAllowedLocalHost(host: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (!host) return true;
  const hostname = hostUrl(host)?.hostname.toLowerCase();
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || allowedHosts.has(hostname)) return true;
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}

/** Logs each distinct refused value once (bounded), naming the setting that admits it. */
function refusalLogger(kind: 'origin' | 'host', setting: string): (value: string) => void {
  const seen = new Set<string>();
  let capped = false;
  return (value) => {
    if (seen.has(value)) return;
    if (seen.size >= REFUSAL_LOG_LIMIT) {
      // A page can spend the budget on junk values; say so once.
      if (!capped) log.warn('auth', `refused ${REFUSAL_LOG_LIMIT} distinct ${kind}s; further refusals are not logged`);
      capped = true;
      return;
    }
    seen.add(value);
    log.warn('auth', `refused a request from a ${kind} that may not use the API; set ${setting} to allow it`, { [kind]: value });
  };
}

/** A MICHI_ALLOWED_HOSTS entry as a host name: `name`, `name:port` and URLs all name a host. */
function allowedHostName(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname.toLowerCase(); } catch { return null; }
}

/** Host names admitted by isAllowedLocalHost; defaults to MICHI_ALLOWED_HOSTS. */
export function allowedHostNames(entries: readonly string[] = listFromEnv('MICHI_ALLOWED_HOSTS')): Set<string> {
  return new Set(entries.map(allowedHostName).filter((name): name is string => !!name));
}

/**
 * Refuse a request whose Origin is not allowed, before any route runs.
 * CORS only hides responses from other sites; a simple POST would still
 * run its handler. Requests without an Origin pass.
 */
export function createOriginGuard(options: LocalOriginOptions = {}): RequestHandler {
  const logRefusal = refusalLogger('origin', 'MICHI_CORS_ORIGINS');
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isAllowedLocalOrigin(origin, req.headers.host, options)) {
      logRefusal(origin);
      res.status(403).json({ error: 'This origin may not use the Michi API. Add it to MICHI_CORS_ORIGINS to allow it.' });
      return;
    }
    next();
  };
}

/**
 * Refuse a request whose Host is neither loopback, an IP address nor in
 * MICHI_ALLOWED_HOSTS: against DNS rebinding, where a site points its own
 * name at the backend and its page becomes same-origin with it, so no
 * Origin check sees it. A local reverse proxy or tunnel that keeps its
 * public host name goes in MICHI_ALLOWED_HOSTS (host names, any port).
 */
export function createLoopbackHostGuard(allowedHosts?: readonly string[]): RequestHandler {
  const allowed = allowedHostNames(allowedHosts);
  const logRefusal = refusalLogger('host', 'MICHI_ALLOWED_HOSTS');
  return (req, res, next) => {
    const host = req.headers.host;
    if (isAllowedLocalHost(host, allowed)) { next(); return; }
    // The host name, which is what MICHI_ALLOWED_HOSTS takes.
    logRefusal(hostUrl(host)?.hostname.toLowerCase() ?? String(host));
    res.status(403).json({ error: 'This host name may not use the Michi API. Add it to MICHI_ALLOWED_HOSTS to allow it.' });
  };
}

export interface LocalAccessGuardOptions extends LocalOriginOptions {
  /** MICHI_REMOTE_ACCESS: a bearer token guards the API, so no Host guard. */
  remoteAccess: boolean;
  allowedHosts?: readonly string[];
}

/**
 * The no-auth access stack, in order: the Host guard (unless remote access
 * guards the API with its token), CORS for allowed origins only, then the
 * Origin guard. server.ts mounts it before every route.
 */
export function installLocalAccessGuards(app: Express, options: LocalAccessGuardOptions): void {
  if (!options.remoteAccess) app.use(createLoopbackHostGuard(options.allowedHosts));
  app.use(cors((req, callback) => callback(null, {
    origin: isAllowedLocalOrigin(req.headers.origin, req.headers.host, options),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })));
  app.use(createOriginGuard(options));
}
