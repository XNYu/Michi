import assert from 'node:assert/strict';
import http from 'node:http';
import { test, type TestContext } from 'node:test';
import express from 'express';
import {
  configuredOrigins,
  installLocalAccessGuards,
  isAllowedLocalHost,
  isAllowedLocalOrigin,
  type LocalAccessGuardOptions,
} from '../src/services/localOrigins';
import { log } from '../src/services/logger';

const HOST = '127.0.0.1:3000';
const allowed = (origin: string | undefined, host: string | undefined = HOST, options: { configured?: string[]; allowAnyLoopback?: boolean; devRenderer?: boolean } = {}) =>
  isAllowedLocalOrigin(origin, host, { configured: [], allowAnyLoopback: false, devRenderer: false, ...options });

test('Michi\'s own UI and configured origins are allowed', () => {
  // Requests without an Origin carry no cross-origin risk.
  assert.equal(allowed(undefined), true);
  // The UI served by this backend, also under a non-loopback host name.
  assert.equal(allowed('http://127.0.0.1:3000'), true);
  assert.equal(allowed('http://michi-box:3000', 'michi-box:3000'), true);
  // localhost / 127.0.0.1 / [::1] on the backend's port are one host.
  assert.equal(allowed('http://localhost:3000'), true);
  assert.equal(allowed('http://[::1]:3000'), true);
  // electron-dev's random port arrives as MICHI_RENDERER_URL (configured).
  assert.equal(allowed('http://127.0.0.1:51234', HOST, { configured: ['http://127.0.0.1:51234'] }), true);
  assert.equal(allowed('https://michi.example', HOST, { configured: ['https://michi.example'] }), true);
});

test('loopback :3001 is `npm run dev`\'s renderer only in a development build', () => {
  assert.equal(allowed('http://localhost:3001', HOST, { devRenderer: true }), true);
  assert.equal(allowed('http://127.0.0.1:3001', HOST, { devRenderer: true }), true);
  // The packaged app: another local app on :3001 is not Michi.
  assert.equal(allowed('http://localhost:3001'), false);
  assert.equal(allowed('http://localhost:3002', HOST, { devRenderer: true }), false);
});

test('other sites, other local servers and opaque origins are refused', () => {
  assert.equal(allowed('https://untrusted.example'), false);
  assert.equal(allowed('http://localhost.untrusted.example:3001', HOST, { devRenderer: true }), false);
  assert.equal(allowed('http://127.0.0.1.untrusted.example:3000'), false);
  // Another local server's page (the user's dev app, a served download).
  assert.equal(allowed('http://localhost:5173'), false);
  assert.equal(allowed('http://127.0.0.1:8000'), false);
  // Unless every loopback port is opted in.
  assert.equal(allowed('http://localhost:5173', HOST, { allowAnyLoopback: true }), true);
  assert.equal(allowed('https://untrusted.example', HOST, { allowAnyLoopback: true }), false);
  // Sandboxed iframes and file:// pages send `null`; any site can.
  assert.equal(allowed('null'), false);
  assert.equal(allowed('chrome-extension://abcdef'), false);
  assert.equal(allowed('not a url'), false);
  // A non-loopback page does not match by host when ours is unknown.
  assert.equal(allowed('http://michi-box:3000', undefined), false);
  // 0.0.0.0 is not a loopback name (browsers have let it reach localhost).
  assert.equal(allowed('http://0.0.0.0:3001', HOST, { devRenderer: true }), false);
});

test('defaults come from the environment', (t) => {
  const keys = ['MICHI_CORS_ORIGINS', 'MICHI_LOCAL_CONTROL_ORIGINS', 'MICHI_RENDERER_URL', 'MICHI_ALLOW_LOOPBACK_ORIGINS', 'NODE_ENV', 'MICHI_DEV_RENDERER'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.MICHI_CORS_ORIGINS = ' https://a.example , ,https://b.example/';
  process.env.MICHI_LOCAL_CONTROL_ORIGINS = 'http://127.0.0.1:4100';
  process.env.MICHI_RENDERER_URL = 'http://127.0.0.1:51234/index.html';
  delete process.env.MICHI_ALLOW_LOOPBACK_ORIGINS;
  delete process.env.NODE_ENV;
  delete process.env.MICHI_DEV_RENDERER;
  assert.deepEqual(configuredOrigins().sort(), ['http://127.0.0.1:4100', 'http://127.0.0.1:51234', 'https://a.example', 'https://b.example']);
  assert.equal(isAllowedLocalOrigin('https://b.example', HOST), true);
  assert.equal(isAllowedLocalOrigin('http://127.0.0.1:51234', HOST), true);
  assert.equal(isAllowedLocalOrigin('https://c.example', HOST), false);
  assert.equal(isAllowedLocalOrigin('http://localhost:5173', HOST), false);
  assert.equal(isAllowedLocalOrigin('http://localhost:3001', HOST), false, 'no dev renderer outside the dev watch build');
  // A packaged app can inherit NODE_ENV from the user's environment: it is not the switch.
  process.env.NODE_ENV = 'development';
  assert.equal(isAllowedLocalOrigin('http://localhost:3001', HOST), false);
  process.env.MICHI_DEV_RENDERER = '1';
  assert.equal(isAllowedLocalOrigin('http://localhost:3001', HOST), true);
  process.env.MICHI_ALLOW_LOOPBACK_ORIGINS = '1';
  assert.equal(isAllowedLocalOrigin('http://localhost:5173', HOST), true);
});

test('hosts: loopback names, IP literals and listed names pass; other DNS names do not', () => {
  const listed = new Set(['michi.tunnel.example']);
  for (const host of [undefined, '127.0.0.1:3000', 'LOCALHOST:3000', 'localhost', '[::1]:3000', '192.168.1.20:3000', '10.0.0.5', '[fe80::1]:3000', 'michi.tunnel.example:443', 'MICHI.Tunnel.Example']) {
    assert.equal(isAllowedLocalHost(host, listed), true, String(host));
  }
  for (const host of ['rebind.evil:3000', 'localhost.:3000', 'michi-box:3000', 'junk:abc', 'tunnel.example']) {
    assert.equal(isAllowedLocalHost(host, listed), false, host);
  }
});

/** server.ts's no-auth stack (installLocalAccessGuards), with a handler that records whether it ran. */
async function noAuthApp(t: TestContext, options: Partial<LocalAccessGuardOptions> = {}) {
  const ran: string[] = [];
  const app = express();
  installLocalAccessGuards(app, { remoteAccess: false, configured: [], allowAnyLoopback: false, devRenderer: true, allowedHosts: ['michi.tunnel.example'], ...options });
  app.all('/api/ping', (req, res) => { ran.push(req.method); res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  // fetch() will not set Host; use http.request.
  const request = (headers: Record<string, string>, method = 'POST') => new Promise<{ status: number; acao: string | undefined }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', method, headers: { 'content-type': 'text/plain', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, acao: res.headers['access-control-allow-origin'] as string | undefined }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? 'x' : undefined);
  });
  return { port, ran, request };
}

test('allowed origins get CORS headers; other sites get none and their requests never reach a route', async (t) => {
  const warned: unknown[] = [];
  t.mock.method(log, 'warn', (_stage: string, _msg: string, data: unknown) => { warned.push(data); });
  const { port, ran, request } = await noAuthApp(t);

  assert.equal((await request({ origin: `http://127.0.0.1:${port}` })).status, 200);
  const dev = await request({ origin: 'http://localhost:3001' }, 'GET');
  assert.equal(dev.acao, 'http://localhost:3001');
  assert.equal((await request({})).status, 200);
  assert.deepEqual(ran, ['POST', 'GET', 'POST']);

  // A simple (unpreflighted) cross-site POST: CORS alone would run it.
  const simple = await request({ origin: 'https://untrusted.example' });
  assert.equal(simple.status, 403);
  assert.equal(simple.acao, undefined);
  // Another local server's page and an opaque origin, likewise.
  for (const origin of ['http://localhost:5173', 'null']) assert.equal((await request({ origin })).status, 403, origin);
  // Its preflight gets no allow headers either.
  const preflight = await request({ origin: 'https://untrusted.example', 'access-control-request-method': 'POST' }, 'OPTIONS');
  assert.equal(preflight.acao, undefined);
  assert.deepEqual(ran, ['POST', 'GET', 'POST'], 'no refused request reached the route');
  // Each refused origin is logged once.
  await request({ origin: 'https://untrusted.example' });
  assert.deepEqual(warned.filter((data) => (data as { origin?: string }).origin === 'https://untrusted.example').length, 1);
});

test('a rebound host name is refused; loopback, IP and listed hosts pass', async (t) => {
  t.mock.method(log, 'warn', () => {});
  const { port, ran, request } = await noAuthApp(t);
  // A page at http://rebind.evil:<port> after its DNS answer became the
  // backend's address: same-origin, so no Origin check sees it.
  assert.equal((await request({ host: `rebind.evil:${port}`, origin: `http://rebind.evil:${port}` })).status, 403);
  assert.equal((await request({ host: `rebind.evil:${port}` })).status, 403);
  assert.equal((await request({ host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await request({ host: `localhost:${port}` })).status, 200);
  assert.equal((await request({ host: `[::1]:${port}` })).status, 200);
  // LAN access by address: rebinding needs a DNS name.
  assert.equal((await request({ host: `192.168.1.20:${port}`, origin: `http://192.168.1.20:${port}` })).status, 200);
  assert.equal((await request({ host: `MICHI.tunnel.example:${port}`, origin: `http://michi.tunnel.example:${port}` })).status, 200);
  assert.equal(ran.length, 5);
});

test('with remote access, the bearer token guards the API and no host guard runs', async (t) => {
  const { port, request } = await noAuthApp(t, { remoteAccess: true });
  assert.equal((await request({ host: `michi-box.tailnet:${port}` })).status, 200);
  // The origin guard still applies.
  assert.equal((await request({ host: `michi-box.tailnet:${port}`, origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request({ host: `michi-box.tailnet:${port}`, origin: `http://michi-box.tailnet:${port}` })).status, 200);
});

test('MICHI_ALLOWED_HOSTS entries name hosts; refusals log the host name, and say once when the log is full', async (t) => {
  const warned: Array<{ msg: string; data: unknown }> = [];
  t.mock.method(log, 'warn', (_stage: string, msg: string, data: unknown) => { warned.push({ msg, data }); });
  // Copied from a refusal log or a browser bar: a port or a scheme still names the host.
  const { port, request } = await noAuthApp(t, { allowedHosts: ['my-box.local:3000', 'https://Michi.Tunnel.Example/', ' '] });
  assert.equal((await request({ host: `my-box.local:${port}` })).status, 200);
  assert.equal((await request({ host: 'michi.tunnel.example' })).status, 200);

  assert.equal((await request({ host: `Other-Box.local:${port}` })).status, 403);
  const hostLogs = () => warned.filter(({ data }) => data && typeof data === 'object' && 'host' in data);
  assert.deepEqual(hostLogs().map(({ data }) => data), [{ host: 'other-box.local' }], 'the host name, without the port');

  for (let i = 0; i < 60; i += 1) await request({ host: `junk-${i}.evil:${port}` });
  assert.equal(hostLogs().length, 50, 'bounded');
  assert.equal(warned.filter(({ msg }) => /further refusals are not logged/.test(msg)).length, 1);
});
