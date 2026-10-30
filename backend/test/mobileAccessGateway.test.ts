import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import type { StreamTransportResponse } from 'michi-shared';
import { createMobileAccessGateway } from '../src/services/mobileAccessGateway';
import { createStreamTransport } from '../src/services/streamTransport';
import { createLocalOriginGuard } from '../src/routes/middleware/localControl';

const origin = 'https://michi.tail123.ts.net';
const bundle = 'console.log("michi");\n'.repeat(100);
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(predicate(), 'condition did not become true');
}
async function fixture(t: TestContext, identityHeader: 'tailscale-user-login' = 'tailscale-user-login') {
  const app = express();
  app.use(express.json());
  const calls: Array<{ path: string; headers: Record<string, unknown>; body: unknown }> = [];
  app.use('/api', createLocalOriginGuard({ loopbackListener: true }), (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-backend-token') return res.status(401).end();
    next();
  });
  const transport = createStreamTransport();
  app.use('/api', transport.router);
  let subscribers = 0;
  app.all('/{*path}', (req, res) => {
    calls.push({ path: req.originalUrl, headers: req.headers, body: req.body });
    if (req.path.endsWith('/stream')) {
      subscribers++;
      res.on('close', () => subscribers--);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('event: chunk\ndata: {"text":"中文😀"}\n\n');
    } else if (req.path.startsWith('/assets/')) res.type('js').send(bundle);
    else res.json({ ok: true });
  });
  const upstream = app.listen(0, '127.0.0.1');
  transport.attach(upstream);
  await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const target = `http://127.0.0.1:${address.port}`;
  let now = Date.now();
  const options = { target, token: 'fixture-backend-token', owner: 'owner', identityHeader, probeToken: 'fixture-readiness-challenge', publicOrigin: () => origin, now: () => now };
  let gateway = createMobileAccessGateway(options);
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const local = gateway.server.address(); assert.ok(local && typeof local !== 'string');
  let base = `http://127.0.0.1:${local.port}`;
  const headers: Record<string, string> = { [identityHeader]: 'owner', origin };
  const exchange = async (link = gateway.mintLink()) => fetch(`${base}/_michi/mobile/session`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(link.url).hash.slice(1) }),
  });
  const restart = async () => {
    await gateway.close();
    gateway = createMobileAccessGateway(options);
    gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
    const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  };
  t.after(async () => {
    await gateway.close(); transport.close(); upstream.closeAllConnections();
    await new Promise<void>(r => upstream.close(() => r()));
  });
  return { get gateway() { return gateway; }, get base() { return base; }, target, headers, calls, exchange, restart,
    subscribers: () => subscribers, advance: (ms: number) => { now += ms; } };
}

test('Tailscale ingress requires the Serve owner identity and never forwards provider identity or caller credentials', async t => {
  const f = await fixture(t, 'tailscale-user-login');
  for (const headers of [{ 'x-claimed-user': 'owner' }, { 'tailscale-user-login': 'another' }] as Record<string, string>[]) {
    assert.equal((await fetch(f.base + '/api/workspaces', { headers })).status, 403);
  }
  const response = await fetch(f.base + '/api/workspaces', { headers: { ...f.headers,
    'tailscale-user-name': 'private name', authorization: 'Bearer attacker', cookie: 'attacker=1' } });
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].headers['tailscale-user-login'], undefined);
  assert.equal(f.calls[0].headers['tailscale-user-name'], undefined);
  assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-backend-token');
  assert.equal(f.calls[0].headers.cookie, undefined);
  assert.equal((await fetch(f.base + '/api/mobile-access', { headers: f.headers })).status, 403);
  assert.equal((await fetch(f.base + '/api/workspaces', { headers: { ...f.headers, origin: 'https://evil.example' } })).status, 403);
  const ready = await fetch(f.base + '/_michi/mobile/ready', { headers: f.headers });
  assert.equal(await ready.text(), 'fixture-readiness-challenge');
  assert.equal((await fetch(f.base + '/_michi/mobile/ready')).status, 403);
  assert.equal((await fetch(f.base + '/_michi/mobile/ready', { headers: { ...f.headers, origin: 'https://evil.example' } })).status, 403);
});

test('requires the stamped owner and rejects foreign origins before any UI/API access', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { 'tailscale-user-login': 'someone' }, { ...f.headers, origin: 'https://evil.example' }, { 'tailscale-user-login': 'owner', 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await fetch(f.base + '/mobile-connect', { headers })).status, 403);
  }
  assert.equal((await fetch(f.base + '/api/workspaces')).status, 403);
  const page = await fetch(f.base + '/mobile-connect', { headers: { 'tailscale-user-login': 'owner' } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /history.replaceState/);
  assert.equal(f.calls.length, 0);
});

test('one stable link works without phone cookies, after legacy expiry and after gateway restart', async t => {
  const f = await fixture(t);
  const link = f.gateway.mintLink();
  assert.equal(link.url, origin + '/'); assert.equal(link.reusable, true);
  const open = async () => {
    assert.equal(f.gateway.mintLink().url, link.url);
    const page = await fetch(f.base + new URL(link.url).pathname, { headers: { 'tailscale-user-login': 'owner' } });
    assert.equal(page.status, 200); assert.equal(page.headers.get('set-cookie'), null);
    assert.equal((await fetch(f.base + '/api/workspaces', { headers: f.headers })).status, 200);
  };
  await open(); await open();
  f.advance(7 * 24 * 60 * 60_000); await open();
  await f.restart(); await open();
});

test('old saved pairing URLs and already-open pairing pages migrate without tokens or new cookies', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const page = await fetch(f.base + '/mobile-connect#used-or-expired-token', { headers: f.headers });
    const html = await page.text();
    assert.match(html, /history.replaceState/); assert.match(html, /location.replace\('\/'\)/);
    assert.doesNotMatch(html, /fetch\(|expired|new link/i);
    const response = await f.exchange({ url: origin + '/mobile-connect#old', expiresAt: 0 });
    assert.equal(response.status, 204); assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('allows owner login-return navigation but rejects cross-site fetches, frames, APIs and writes', async t => {
  const f = await fixture(t);
  const navigation = { 'tailscale-user-login': 'owner', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' };
  // fetch sets sec-fetch-mode itself; mode:navigate is not available to it.
  const { request } = await import('node:http');
  const navigate = (path: string, overrides: Record<string, string> = {}, method = 'GET') => new Promise<number>(resolve => {
    const req = request(f.base + path, { method, headers: { ...navigation, 'sec-fetch-mode': 'navigate', ...overrides } }, res => { res.resume(); resolve(res.statusCode!); });
    req.end();
  });
  assert.equal(await navigate('/'), 200);
  assert.equal(await navigate('/mobile-connect'), 200);
  for (const path of ['/api/workspaces', '/%61pi/workspaces', '/_michi/mobile/session']) assert.equal(await navigate(path), 403);
  assert.equal(await navigate('/', { 'sec-fetch-dest': 'iframe' }), 403);
  assert.equal(await navigate('/', { 'sec-fetch-mode': 'cors' }), 403);
  assert.equal(await navigate('/', { 'tailscale-user-login': 'someone' }), 403);
  assert.equal(await navigate('/', { origin: 'https://evil.example' }), 403);
  assert.equal(await navigate('/', {}, 'POST'), 403);
  const error = await fetch(f.base, { headers: { ...f.headers, origin: 'https://evil.example' } });
  assert.match(await error.text(), /same-origin/);
});

test('proxies same-origin API calls, strips credentials/forwarding headers and blocks management even in proxy paths', async t => {
  const f = await fixture(t); const cookie = '__Host-michi-mobile=stale';
  const headers = { ...f.headers, cookie, authorization: 'Bearer malicious-client-value', 'x-forwarded-host': 'evil.example', 'content-type': 'application/json' };
  const response = await fetch(f.base + '/api/workspaces', { method: 'POST', headers, body: '{"name":"Phone"}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { ok: boolean }).ok, true);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.deepEqual(f.calls[0].body, { name: 'Phone' });
  assert.equal(f.calls[0].headers.origin, f.target);
  assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-backend-token');
  for (const name of ['cookie', 'x-forwarded-host', 'tailscale-user-login']) assert.equal(f.calls[0].headers[name], undefined);
  for (const path of ['/api/mobile-access/link', '/api/MOBILE-ACCESS', '/api/backend-connections/id/proxy/mobile-access/start', '/api/%6dobile-access']) {
    assert.equal((await fetch(f.base + path, { headers })).status, 403);
  }
  assert.equal((await fetch(f.base + '/api/workspaces', { method: 'POST', headers: { cookie, 'tailscale-user-login': 'owner' } })).status, 403);
});

test('lets the phone cache fingerprinted assets and gzips known-length bodies it accepts', async t => {
  const f = await fixture(t);
  const asset = await fetch(f.base + '/assets/index-Dfme4gZv.js', { headers: f.headers });
  assert.equal(asset.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(asset.headers.get('content-encoding'), 'gzip');
  assert.equal(await asset.text(), bundle);
  for (const path of ['/', '/api/workspaces']) {
    assert.equal((await fetch(f.base + path, { headers: f.headers })).headers.get('cache-control'), 'no-store');
  }
  const identity = await fetch(f.base + '/assets/index-Dfme4gZv.js', { headers: { ...f.headers, 'accept-encoding': 'identity' } });
  assert.equal(identity.headers.get('content-encoding'), null);
  assert.equal(await identity.text(), bundle);
});

for (const identityHeader of ['tailscale-user-login'] as const) {
test(`${identityHeader}: streams SSE incrementally and client disconnect only releases that subscriber`, async t => {
  const f = await fixture(t, identityHeader);
  const controller = new AbortController();
  const response = await fetch(f.base + '/api/chats/node/stream', { headers: f.headers, signal: controller.signal });
  assert.equal(response.headers.get('content-encoding'), null);
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /中文😀/);
  assert.equal(f.subscribers(), 1);
  controller.abort(); await reader.cancel().catch(() => {});
  await until(() => f.subscribers() === 0);
  assert.ok(f.calls.every(c => !c.path.endsWith('/cancel')));
});

test(`${identityHeader}: real multiplexed WS tickets work through the ingress, retain route guards, reject replay and revoke without stopping the server`, async t => {
  const f = await fixture(t, identityHeader);
  const response = await fetch(f.base + '/api/stream-transport', { method: 'POST', headers: f.headers });
  assert.equal(response.status, 200);
  const { token } = await response.json() as { token: string };
  const url = f.base.replace('http:', 'ws:') + '/api/stream-transport?token=' + token;
  for (const headers of [{ ...f.headers, origin: 'https://evil.example' }, { [identityHeader]: 'owner' }, { ...f.headers, [identityHeader]: 'someone' }]) {
    const wrong = new WebSocket(url, { headers });
    await assert.rejects(once(wrong, 'open'), /403/);
  }
  const socket = new WebSocket(url, { headers: f.headers });
  const frames: StreamTransportResponse[] = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'open', id: 'stream', path: '/api/chats/node/stream', method: 'GET' }));
  await until(() => frames.some(f => f.type === 'data'));
  assert.ok(frames.some(f => f.type === 'data' && f.text.includes('中文😀')));
  socket.send(JSON.stringify({ type: 'open', id: 'forbidden', path: '/api/mobile-access/link', method: 'POST' }));
  await until(() => frames.some(f => f.type === 'error' && f.id === 'forbidden'));
  const replay = new WebSocket(url, { headers: f.headers });
  await assert.rejects(once(replay, 'open'), /403/);
  const closed = once(socket, 'close'); f.gateway.disconnect(); await closed;
  await until(() => f.subscribers() === 0);
  assert.equal((await fetch(f.base + '/api/workspaces', { headers: f.headers })).status, 200);
  const nextTicket = await fetch(f.base + '/api/stream-transport', { method: 'POST', headers: f.headers });
  const next = new WebSocket(f.base.replace('http:', 'ws:') + '/api/stream-transport?token=' + (await nextTicket.json() as { token: string }).token, { headers: f.headers });
  await once(next, 'open');
  const stopped = once(next, 'close'); await f.gateway.close(); await stopped;
});
}
