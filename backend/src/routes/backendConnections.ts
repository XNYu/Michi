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
import { requireLocalControlRequest } from './middleware/localControl';
import { RemoteDesktopError, RemoteDesktopSetup } from '../services/remoteDesktopSetup';
import { RemoteDiagnosticLog, readRemoteDiagnostic } from '../services/remoteDiagnostics';

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

export function setupBackendConnectionRoutes(options: { tunnelManager?: SshTunnelManager; remoteSetup?: RemoteDesktopSetup } = {}): express.Router {
  const router = express.Router();
  const tunnelManager = options.tunnelManager ?? sshTunnelManager;
  const remoteSetup = options.remoteSetup ?? new RemoteDesktopSetup({ tunnelManager });

  // These routes can replay a stored remote credential. Apply the same strict
  // local-control boundary used by the Custom Agents backend toggle.
  router.use('/backend-connections', requireLocalControlRequest);

  router.post('/backend-connections/connect-ssh', async (req, res) => {
    if (typeof req.body?.host !== 'string') return res.status(400).json({ error: 'SSH host is required' });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    const emit = (value: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(value) + '\n');
    };
    const diagnostic = new RemoteDiagnosticLog(req.body.host);
    emit({ type: 'attempt', id: diagnostic.report.id });
    try {
      const result = await remoteSetup.connect(req.body.host, req.body.install === true,
        (stage, message) => { diagnostic.stage(stage, message); emit({ type: 'progress', stage, message }); }, controller.signal, diagnostic);
      diagnostic.append('result', result.kind);
      if (result.kind === 'connected' && result.runtimeWarnings.length > 0) {
        const runtimeWarnings = diagnostic.warn(result.runtimeWarnings);
        diagnostic.save();
        emit({ type: 'result', result: { ...result, runtimeWarnings, diagnostic: diagnostic.report } });
      } else emit({ type: 'result', result });
    } catch (error) {
      diagnostic.fail(error, error instanceof RemoteDesktopError ? error.code : 'setup_failed');
      diagnostic.save();
      emit({ type: 'error', code: diagnostic.report.code, message: diagnostic.report.message, diagnostic: diagnostic.report });
    } finally { diagnostic.finish(); res.end(); }
  });

  router.get('/backend-connections/diagnostics/:attemptId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const diagnostic = readRemoteDiagnostic(req.params.attemptId);
    if (!diagnostic) return res.status(404).json({ error: 'Diagnostic not found or expired.' });
    res.json(diagnostic);
  });

  router.get('/backend-connections/:id/directories', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const directory = await remoteSetup.browse(req.params.id,
        typeof req.query.path === 'string' ? req.query.path : '~', controller.signal);
      res.json(directory);
    } catch (error) {
      res.status(400).json({ error: error instanceof RemoteDesktopError ? error.message : 'Could not read the remote folder.' });
    }
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

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const apiUrl = await tunnelManager.apiUrl(connection);
      if (controller.signal.aborted) return;
      const targetUrl = `${apiUrl}/${suffix}${query}`;
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
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
      if (controller.signal.aborted) return;
      if (!res.headersSent) {
        res.status(502).json({ error: `Remote backend unavailable: ${(err as Error).message}` });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
