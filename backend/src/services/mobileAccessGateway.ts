import { randomBytes } from 'node:crypto';
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { MobileAccessLink } from 'michi-shared';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'trailer', 'te']);
// Vite puts a content hash in every file name under /assets/, so a cached copy is never stale.
const FINGERPRINTED_ASSET = /^\/assets\/[^/]+$/;
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/i;

/** A separate ingress, never the desktop's unauthenticated loopback API.
 * Tailscale Serve must target a private Unix socket and
 * strip/stamp their verified identity header. Only this server attaches the
 * backend token upstream. Never expose this ingress on a shared TCP listener. */
export function createMobileAccessGateway(options: {
  target: string;
  token?: string | null;
  owner: string;
  /** Only use the Serve header behind a private, owner-only Unix listener. */
  identityHeader?: 'tailscale-user-login';
  /** Per-run response challenge for an authenticated Serve readiness check. */
  probeToken?: string;
  publicOrigin: () => string;
  now?: () => number;
}) {
  const target = new URL(options.target);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) {
    throw new Error('Mobile access requires a loopback Michi backend');
  }
  const now = options.now ?? Date.now;
  const sockets = new Set<Duplex>();
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  const refusal = (req: IncomingMessage, pathname: string, upgrade = false): string | null => {
    const origin = options.publicOrigin();
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
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
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
    if (/(?:^|\/)mobile-access(?:\/|$)/i.test(pathname) || pathname.startsWith('/_michi/')) {
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
  server.requestTimeout = 30_000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
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
  return {
    server,
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
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
