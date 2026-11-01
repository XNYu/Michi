import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { MobileAccessLink } from 'michi-shared';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'trailer', 'te']);
// Vite puts a content hash in every file name under /assets/, so a cached copy is never stale.
const FINGERPRINTED_ASSET = /^\/assets\/[^/]+$/;
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/i;

/** Whether any reading of a path can reach a phone-access management route.
 * Routes match raw paths; the saved-connection proxy decodes its segments and
 * re-fetches them, and WHATWG URL parsing reads a backslash as '/', removes tab
 * and newline, and ends a path at '?', '#' or trailing controls. So check
 * repeated percent-decoding with every such separator; names such as
 * 'mobile-access.md' stay reachable. */
function namesManagementRoute(path: string): boolean {
  let view = path;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try { next = decodeURIComponent(view); } catch { break; }
    if (next === view) break;
    view = next;
  }
  return /(?:^|[/\\])mobile-access(?![a-z0-9._~-])/.test(view.replace(/[\t\n\r]/g, '').toLowerCase());
}

/** A separate ingress, never the desktop's unauthenticated loopback API.
 * Tailscale Serve strips caller-supplied identity and stamps its verified
 * user header. Only this server attaches the backend token upstream.
 * The header is trustworthy only when the listener itself proves the caller:
 * a private, owner-only Unix socket (macOS/Linux), or a loopback TCP listener
 * with `verifyConnection` (OS-verified Tailscale service peer) plus `pathSecret`
 * (the per-run segment Michi's own Serve handler prepends). Never listen on
 * shared TCP without both. */
export function createMobileAccessGateway(options: {
  target: string;
  token?: string | null;
  owner: string;
  /** Only use the Serve header behind a listener that proves its caller (see above). */
  identityHeader?: 'tailscale-user-login';
  /** Per-run response challenge for an authenticated Serve readiness check. */
  probeToken?: string;
  publicOrigin: () => string;
  now?: () => number;
  /** TCP ingress: resolves only for a connection proven to come from the
   * provider. Unverified sockets are destroyed before any byte is parsed. */
  verifyConnection?: (socket: Socket) => Promise<void>;
  /** TCP ingress: required first path segment, removed before routing. */
  pathSecret?: string;
  /** Bound for receiving one complete request (default 30s). */
  requestTimeoutMs?: number;
}) {
  const target = new URL(options.target);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) {
    throw new Error('Mobile access requires a loopback Michi backend');
  }
  if (options.pathSecret !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(options.pathSecret)) throw new Error('Invalid mobile access path secret');
  if (options.verifyConnection && !options.pathSecret) throw new Error('A verified TCP ingress also requires a path secret');
  const secret = options.pathSecret ? Buffer.from(options.pathSecret) : null;
  /** Returns the request target without the secret segment, or null when absent. */
  const unwrap = (url: string | undefined): string | null => {
    if (!secret) return url ?? null;
    if (!url?.startsWith('/')) return null;
    const end = url.slice(1).search(/[/?]/);
    const given = Buffer.from(end < 0 ? url.slice(1) : url.slice(1, end + 1));
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) return null;
    const rest = end < 0 ? '' : url.slice(end + 1);
    return rest.startsWith('/') ? rest : `/${rest}`;
  };
  const now = options.now ?? Date.now;
  const sockets = new Set<Duplex>();
  const verified = new WeakSet<object>();
  let generation = 0;
  const disconnect = () => { generation++; for (const socket of sockets) socket.destroy(); };
  const refusal = (req: IncomingMessage, pathname: string, upgrade = false): string | null => {
    const origin = options.publicOrigin();
    if (options.verifyConnection && !verified.has(req.socket)) return 'Mobile access is restricted to the tunnel owner.';
    // Serve marks public Funnel traffic and never stamps an identity on it.
    if (req.headers['tailscale-funnel-request'] !== undefined) return 'Mobile access is restricted to the tunnel owner.';
    // The selected provider strips caller-supplied identity and stamps its
    // verified user on HTTP and WebSocket upgrades. Do not trust forwarded Host.
    if (!origin || req.headers[options.identityHeader ?? 'tailscale-user-login'] !== options.owner) return 'Mobile access is restricted to the tunnel owner.';
    const originError = 'Mobile access requires a same-origin request. Open the phone link directly in your browser.';
    if (req.headers.origin !== undefined) return req.headers.origin === origin ? null : originError;
    if (upgrade || !['GET', 'HEAD'].includes(req.method ?? '')) return originError;
    if (req.headers['sec-fetch-site'] !== 'cross-site') return null;
    // An owner can open the UI from another site. Permit that top-level entry,
    // while keeping cross-site fetches, frames and even GET APIs blocked.
    return req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
      && !/^\/(?:api|_michi)(?:\/|$)/.test(pathname) ? null : originError;
  };
  const headersFor = (req: IncomingMessage, upgrade = false): IncomingHttpHeaders => {
    const headers: IncomingHttpHeaders = {};
    const nominated = String(req.headers.connection ?? '').toLowerCase().split(',').map(v => v.trim());
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(key) || nominated.includes(key) || key.startsWith('x-forwarded-')
        || key.startsWith('tailscale-') || ['host', 'origin', 'cookie', 'authorization', 'forwarded'].includes(key)) continue;
      headers[key] = value;
    }
    // Both ticket creation and WS upgrades use the same local origin. The
    // existing one-use stream tickets and all route guards still run.
    headers.host = target.host;
    headers.origin = target.origin;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  };
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  const server = createServer({ connectionsCheckingInterval: Math.min(30_000, requestTimeout) }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const unwrapped = unwrap(req.url);
    if (unwrapped === null) { res.writeHead(404).end(); return; }
    req.url = unwrapped;
    let pathname: string;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error();
      pathname = decodeURIComponent(new URL(req.url, target).pathname).toLowerCase();
    } catch { res.writeHead(400).end(); return; }
    const reason = refusal(req, pathname);
    if (reason) { res.writeHead(403).end(reason); return; }
    if (options.probeToken && pathname === '/_michi/mobile/ready' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(options.probeToken); return;
    }
    if (pathname === '/mobile-connect' && req.method === 'GET') {
      const nonce = randomBytes(16).toString('hex');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Michi</title></head><body><p id="status">Connecting to Michi…</p><script nonce="${nonce}">
history.replaceState(null,'','/mobile-connect');location.replace('/');
</script></body></html>`);
      return;
    }
    if (pathname === '/_michi/mobile/session' && req.method === 'POST') {
      // Compatibility for an already-open legacy pairing page. The verified
      // owner and Origin above are sufficient; there is no session to mint.
      req.resume(); res.writeHead(204).end();
      return;
    }
    // Publishing/minting stays on the authenticated desktop management path.
    // A phone cannot recursively expose another machine through its proxy.
    const rawPath = req.url.split('?', 1)[0];
    if (namesManagementRoute(rawPath) || namesManagementRoute(pathname) || pathname.startsWith('/_michi/')) {
      res.writeHead(403).end(); return;
    }
    const upstream = request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      path: req.url, method: req.method, headers: headersFor(req), agent: false }, response => {
      upstream.setTimeout(0);
      const headers = { ...response.headers };
      for (const key of HOP_HEADERS) delete headers[key];
      delete headers['set-cookie'];
      headers['cache-control'] = req.method === 'GET' && response.statusCode === 200 && FINGERPRINTED_ASSET.test(pathname)
        ? 'private, max-age=31536000, immutable' : 'no-store';
      headers['x-frame-options'] = 'SAMEORIGIN';
      const location = headers.location;
      if (location?.startsWith(target.origin)) headers.location = options.publicOrigin() + location.slice(target.origin.length);
      // Only complete, known-length bodies: SSE and other streams must pass through unbuffered.
      const gzip = response.statusCode === 200 && req.method !== 'HEAD' && !headers['content-encoding']
        && Number(headers['content-length']) >= 1024 && COMPRESSIBLE_TYPE.test(String(headers['content-type'] ?? ''))
        && /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
      if (gzip) {
        delete headers['content-length'];
        headers['content-encoding'] = 'gzip';
        headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding';
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.on('error', () => res.destroy());
      if (gzip) response.pipe(createGzip()).on('error', () => res.destroy()).pipe(res);
      else response.pipe(res);
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end('Michi is unavailable.'); else res.destroy(); });
    // Closing a subscriber only detaches its stream, never cancels a turn.
    res.on('close', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.maxConnections = 256;
  server.requestTimeout = requestTimeout;
  server.headersTimeout = Math.min(server.headersTimeout, server.requestTimeout);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const unwrapped = unwrap(req.url);
    if (unwrapped === null) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    req.url = unwrapped;
    if (refusal(req, '/api/stream-transport', true) || !req.url?.startsWith('/api/stream-transport?')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      path: req.url, headers: headersFor(req, true), agent: false });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      upstream.setTimeout(0);
      sockets.add(peer); peer.on('close', () => sockets.delete(peer));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((s, v, i) => s + v + (i % 2 ? '\r\n' : ': '), '')}\r\n`);
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
      socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  let listener: NetServer = server;
  const verify = options.verifyConnection;
  if (verify) {
    // Paused sockets are not read, so no request is parsed or forwarded until
    // the provider's OS identity is proven for this exact connection.
    listener = createNetServer({ pauseOnConnect: true }, (socket: Socket) => {
      const current = generation;
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      verify(socket).then(() => {
        if (socket.destroyed || current !== generation || !listener.listening) { socket.destroy(); return; }
        verified.add(socket);
        server.emit('connection', socket);
        socket.resume();
      }, () => socket.destroy());
    });
    listener.maxConnections = 256;
    // The HTTP server receives verified sockets but never listens itself.
    // Start the request/headers timeout tracking that listen() would start.
    server.emit('listening');
  }
  return {
    server: listener,
    /** Revoke existing streams while a provider's identity cannot be verified. */
    disconnect,
    mintLink(): MobileAccessLink {
      const origin = options.publicOrigin();
      if (!origin) throw new Error('Connect the tunnel before creating a phone link');
      // Old desktop clients require a numeric expiry to display their QR.
      // This is only a legacy display deadline: the URL itself never expires.
      return { url: `${origin}/`, reusable: true, expiresAt: now() + 5 * 60_000 };
    },
    async close() {
      disconnect();
      // Also stops the inner HTTP server's timeout tracking.
      if (listener !== server) server.close(() => {});
      await new Promise<void>(resolve => listener.close(() => resolve()));
    },
  };
}
