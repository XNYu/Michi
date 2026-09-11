import { randomBytes } from 'node:crypto';
import { request, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { STREAM_TRANSPORT_PATH, STREAM_MAX_BODY_BYTES, STREAM_MAX_FRAME_BYTES, type StreamTransportResponse } from 'michi-shared';

const ENDPOINT = `/api${STREAM_TRANSPORT_PATH}`;
const TICKET_TTL_MS = 30_000;
const MAX_CHANNELS = 256;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const STREAM_PATH = /^\/api\/(?:backend-connections\/[a-zA-Z0-9_-]+\/proxy\/)?(chats\/background\/subscribe|chats\/[a-zA-Z0-9_-]+\/(message|stream)|workspaces\/[a-zA-Z0-9_-]+\/watch\/stream|agent-runs\/subscribe|digests\/stream)$/;

interface Ticket {
  expires: number;
  host: string;
  origin: string;
  headers: IncomingHttpHeaders;
}

/** Mount the ticket router AFTER the existing CORS/session/token middleware. */
export function createStreamTransport() {
  const router = express.Router();
  const tickets = new Map<string, Ticket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: STREAM_MAX_FRAME_BYTES, perMessageDeflate: false });
  let server: Server;

  router.post(STREAM_TRANSPORT_PATH, (req, res) => {
    const origin = req.headers.origin;
    const configuredOrigins = (process.env.MICHI_CORS_ORIGINS ?? '').split(',').map((value) => value.trim());
    if (origin && origin !== 'null') {
      let allowed = configuredOrigins.includes(origin);
      try {
        const parsed = new URL(origin);
        allowed ||= ['http:', 'https:'].includes(parsed.protocol)
          && (parsed.host === req.headers.host || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
      } catch { /* reject malformed Origin */ }
      if (!allowed) return res.status(403).json({ error: 'Stream origin is not allowed' });
    }
    const now = Date.now();
    for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
    if (tickets.size >= 1024) return res.status(429).json({ error: 'Too many pending stream connections' });
    const token = randomBytes(32).toString('hex');
    const headers: IncomingHttpHeaders = {};
    // Capture credentials from the authenticated HTTP request, never from a
    // WebSocket message. Each forwarded request still runs all route guards.
    for (const name of ['host', 'origin', 'cookie', 'authorization', 'x-forwarded-proto']) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    tickets.set(token, {
      expires: now + TICKET_TTL_MS,
      host: req.headers.host ?? '',
      origin: req.headers.origin ?? `${req.protocol}://${req.headers.host}`,
      headers,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token });
  });

  wss.on('connection', (socket: WebSocket, _req: IncomingMessage, ticket: Ticket) => {
    const channels = new Map<string, ClientRequest>();
    let alive = true;
    const send = (frame: StreamTransportResponse) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFER_BYTES) {
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify(frame));
    };
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, 20_000);
    heartbeat.unref();
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const upstream of channels.values()) upstream.destroy();
      channels.clear();
    });
    socket.on('message', (raw, isBinary) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
        if (isBinary || !frame || typeof frame !== 'object') throw new Error();
      } catch {
        socket.close(1008, 'Invalid stream frame');
        return;
      }
      const id = frame.id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
        socket.close(1008, 'Invalid stream id');
        return;
      }
      if (frame.type === 'cancel') {
        channels.get(id)?.destroy();
        channels.delete(id);
        return;
      }
      if (frame.type !== 'open' || channels.has(id)) {
        socket.close(1008, 'Invalid stream operation');
        return;
      }
      let target: URL;
      try {
        if (typeof frame.path !== 'string' || !frame.path.startsWith('/api/')) throw new Error();
        target = new URL(frame.path, 'http://stream.local');
        const match = STREAM_PATH.exec(target.pathname);
        const expectedMethod = target.pathname.endsWith('/message')
          || target.pathname.endsWith('/background/subscribe')
          || target.pathname.endsWith('/digests/stream') ? 'POST' : 'GET';
        if (target.origin !== 'http://stream.local' || !match || target.hash
          || frame.method !== expectedMethod
          || (frame.body !== undefined && typeof frame.body !== 'string')) throw new Error();
      } catch {
        send({ type: 'error', id, message: 'Unsupported stream request' });
        return;
      }
      if (typeof frame.body === 'string' && Buffer.byteLength(frame.body) > STREAM_MAX_BODY_BYTES) {
        send({ type: 'headers', id, status: 413 });
        send({ type: 'end', id });
        return;
      }
      if (channels.size >= MAX_CHANNELS) {
        send({ type: 'headers', id, status: 429 });
        send({ type: 'end', id });
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') return;
      // A server-owned loopback target plus a strict path allowlist prevents
      // this adapter from becoming a general proxy or bypassing route auth.
      const upstream = request({
        hostname: address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address,
        port: address.port,
        path: target.pathname + target.search,
        method: frame.method as string,
        headers: { ...ticket.headers, accept: 'text/event-stream', 'content-type': 'application/json' },
        agent: false,
      });
      channels.set(id, upstream);
      const headerTimer = setTimeout(() => upstream.destroy(new Error('Stream response timed out')), 30_000);
      headerTimer.unref();
      let ended = false;
      const finish = (error?: Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(headerTimer);
        if (channels.get(id) !== upstream) return;
        channels.delete(id);
        send(error ? { type: 'error', id, message: error.message } : { type: 'end', id });
      };
      upstream.on('error', finish);
      upstream.on('close', () => { clearTimeout(headerTimer); });
      upstream.on('response', (response) => {
        clearTimeout(headerTimer);
        const decoder = new StringDecoder('utf8');
        send({ type: 'headers', id, status: response.statusCode ?? 502 });
        response.on('data', (data: Buffer) => {
          const text = decoder.write(data);
          if (text) send({ type: 'data', id, text });
        });
        response.on('end', () => {
          const text = decoder.end();
          if (text) send({ type: 'data', id, text });
          finish();
        });
        response.on('error', finish);
        response.on('aborted', () => finish(new Error('Stream disconnected')));
      });
      upstream.end(typeof frame.body === 'string' ? frame.body : undefined);
    });
  });

  return {
    router,
    attach(httpServer: Server) {
      server = httpServer;
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://stream.local');
        if (url.pathname !== ENDPOINT) { socket.destroy(); return; }
        const token = url.searchParams.get('token') ?? '';
        const ticket = tickets.get(token);
        tickets.delete(token);
        if (!ticket || ticket.expires <= Date.now() || req.headers.host !== ticket.host
          || req.headers.origin !== ticket.origin) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ticket));
      });
    },
    close() {
      tickets.clear();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
  };
}
