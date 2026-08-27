import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import express from 'express';
import {
  type BackendConnectionInput,
  deleteBackendConnection,
  getBackendConnection,
  listBackendConnections,
  normalizeBackendConnection,
  probeBackendConnection,
  saveBackendConnection,
} from '../services/backendConnections';
import { sshTunnelManager, type SshTunnelManager } from '../services/sshTunnelManager';

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'range', 'last-event-id'] as const;
const SKIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

function proxySuffix(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw.join('/');
  return raw ?? '';
}

function isAllowedRendererOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  } catch {
    return false;
  }
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === '') return null;
  if (value === undefined) return undefined;
  return Number(value);
}

function connectionInput(body: Record<string, unknown> | undefined, fallbackName: string): BackendConnectionInput {
  return {
    id: typeof body?.id === 'string' ? body.id : undefined,
    name: typeof body?.name === 'string' ? body.name : fallbackName,
    transport: body?.transport === 'ssh' ? 'ssh' : body?.transport === 'direct' ? 'direct' : undefined,
    apiUrl: typeof body?.apiUrl === 'string' ? body.apiUrl : undefined,
    sshHost: typeof body?.sshHost === 'string' ? body.sshHost : undefined,
    sshUser: typeof body?.sshUser === 'string' ? body.sshUser : undefined,
    sshPort: optionalNumber(body?.sshPort),
    remotePort: optionalNumber(body?.remotePort),
    token: typeof body?.token === 'string' ? body.token : undefined,
  };
}

export function setupBackendConnectionRoutes(options: { tunnelManager?: SshTunnelManager } = {}): express.Router {
  const router = express.Router();
  const tunnelManager = options.tunnelManager ?? sshTunnelManager;

  // These routes can replay a stored remote credential. Reject browser calls
  // from non-local origins; same-origin desktop/dev requests and CLI calls
  // (which carry no Origin header) remain allowed.
  router.use('/backend-connections', (req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedRendererOrigin(origin)) {
      return res.status(403).json({ error: 'backend connections are only available to the local Michi app' });
    }
    next();
  });

  router.get('/backend-connections', (_req, res) => {
    res.json({
      connections: listBackendConnections().map((connection) => {
        if (connection.transport !== 'ssh') return connection;
        const status = tunnelManager.status(connection.id);
        return {
          ...connection,
          tunnelStatus: status.phase,
          tunnelError: status.error,
        };
      }),
    });
  });

  router.post('/backend-connections/test', async (req, res) => {
    const existing = typeof req.body?.id === 'string' ? getBackendConnection(req.body.id) : null;
    let candidateId: string | undefined;
    try {
      const normalized = normalizeBackendConnection(
        connectionInput(req.body, existing?.name ?? 'Connection test'),
        existing ?? undefined,
      );
      const candidate = normalized.transport === 'ssh'
        ? { ...normalized, id: `probe-${randomUUID()}` }
        : normalized;
      candidateId = candidate.transport === 'ssh' ? candidate.id : undefined;
      const apiUrl = await tunnelManager.apiUrl(candidate);
      const result = await probeBackendConnection({
        apiUrl,
        token: normalized.token,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    } finally {
      if (candidateId) tunnelManager.stop(candidateId);
    }
  });

  router.post('/backend-connections', (req, res) => {
    try {
      const connection = saveBackendConnection({
        ...connectionInput(req.body, ''),
      });
      tunnelManager.stop(connection.id);
      res.json({ connection });
    } catch (err) {
      const message = (err as Error).message;
      res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
    }
  });

  router.delete('/backend-connections/:id', (req, res) => {
    const deleted = deleteBackendConnection(req.params.id);
    if (deleted) tunnelManager.stop(req.params.id);
    res.status(deleted ? 200 : 404).json(deleted ? { ok: true } : { error: 'Connection not found' });
  });

  router.all('/backend-connections/:id/proxy/*splat', async (req, res) => {
    const connection = getBackendConnection(req.params.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    const suffix = proxySuffix(req.params.splat);
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    if (connection.token) headers.set('authorization', `Bearer ${connection.token}`);

    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    try {
      const apiUrl = await tunnelManager.apiUrl(connection);
      const targetUrl = `${apiUrl}/${suffix}${query}`;
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (!SKIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
      });
      if (!upstream.body) return res.end();
      const upstreamStream = Readable.fromWeb(upstream.body as never);
      // Detaching the local renderer must release the proxy socket. The
      // remote Michi route treats an SSE disconnect as an observer detach,
      // not as a turn cancellation, so the remote agent keeps running.
      res.on('close', () => upstreamStream.destroy());
      upstreamStream.on('error', () => {
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      upstreamStream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: `Remote backend unavailable: ${(err as Error).message}` });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
