import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupPageMaintenanceRoutes } from '../src/routes/pageMaintenance';

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  const open = server;
  server = null;
  await new Promise<void>((resolve) => { open.close(() => resolve()); open.closeAllConnections(); });
});

async function listen(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', setupPageMaintenanceRoutes({ scheduler: null }));
  // A router mounted after it, as server.ts mounts backup, search and the Meta agent routes.
  app.get('/api/version', (_req, res) => { res.json({ ok: true }); });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

test('without scheduled jobs the maintenance routes answer 503 and leave every other route alone', async () => {
  const base = await listen();
  for (const [method, path] of [
    ['GET', '/api/workspaces/ws/maintenance'],
    ['PATCH', '/api/workspaces/ws/maintenance'],
    ['POST', '/api/workspaces/ws/maintenance/run'],
    ['PATCH', '/api/workspaces/ws/spaces/sp/maintenance'],
  ] as const) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'scheduler_unavailable');
  }
  const other = await fetch(`${base}/api/version`);
  assert.equal(other.status, 200);
  assert.deepEqual(await other.json(), { ok: true });
});
