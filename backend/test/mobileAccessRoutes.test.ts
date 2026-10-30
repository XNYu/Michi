import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { setupMobileAccessRoutes } from '../src/routes/mobileAccess';
import type { MobileAccessController } from '../src/services/mobileAccessManager';

test('management accepts local control and an authenticated remote proxy, rejects foreign browser origins, and never caches sign-in links', async t => {
  let starts = 0;
  const status = { state: 'connected', url: '', error: '', available: true };
  const app = express();
  app.use((req, res, next) => {
    // The existing remote token middleware sets this only after validation.
    if (req.headers.authorization === 'Bearer fixture') res.locals.remoteAccessAuthenticated = true;
    next();
  });
  app.use('/api', setupMobileAccessRoutes({ status: () => status, start: async () => { starts++; return status; },
    stop: async () => status, link: () => ({ url: 'https://fixture.example/mobile-connect#one-use', expiresAt: 1 }),
  } as unknown as MobileAccessController));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/api/mobile-access/start', { method: 'POST', headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal(starts, 0);
  assert.equal((await fetch(base + '/api/mobile-access/start', { method: 'POST', headers: { origin: base } })).status, 200);
  assert.equal((await fetch(base + '/api/mobile-access/start', { method: 'POST', headers: { authorization: 'Bearer fixture' } })).status, 200);
  assert.equal(starts, 2);
  const link = await fetch(base + '/api/mobile-access/link', { method: 'POST', headers: { origin: base } });
  assert.equal(link.status, 200); assert.equal(link.headers.get('cache-control'), 'no-store');
});

test('remembers enable only after the tunnel starts, and remembers disable', async t => {
  let fail = true;
  const remembered: boolean[] = [];
  const status = { state: 'connected', url: '', error: '', available: true };
  const app = express();
  app.use('/api', setupMobileAccessRoutes({ status: () => status, stop: async () => status,
    start: async () => { if (fail) throw new Error('Install Tailscale'); return status; },
  } as unknown as MobileAccessController, { remember: enabled => remembered.push(enabled) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const post = (path: string) => fetch(`http://127.0.0.1:${address.port}/api/mobile-access/${path}`, { method: 'POST', headers: { origin: `http://127.0.0.1:${address.port}` } });
  assert.equal((await post('start')).status, 409);
  assert.deepEqual(remembered, []);
  fail = false;
  assert.equal((await post('start')).status, 200);
  assert.equal((await post('stop')).status, 200);
  assert.deepEqual(remembered, [true, false]);
});

test('Tailscale setup and provider selection remain local-control operations and validate provider input', async t => {
  const calls: string[] = [];
  const status = { state: 'stopped' as const, url: '', error: '', available: true, provider: 'tailscale' as const };
  const app = express(); app.use(express.json());
  app.use('/api', setupMobileAccessRoutes({ status: () => status, start: async () => status, stop: async () => status,
    link: () => ({ url: 'https://michi.tail123.ts.net/', expiresAt: 0, reusable: true }),
    select: async provider => { calls.push(provider); return status; },
    login: async () => { calls.push('login'); return status; },
    openApp: async () => { calls.push('open-app'); return status; },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (action: string, provider?: string, origin = base) => fetch(`${base}/api/mobile-access/${action}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ provider }),
  });
  for (const action of ['login', 'open-app', 'provider']) assert.equal((await post(action, 'tailscale', 'https://evil.example')).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await post('provider', 'funnel')).status, 400);
  assert.equal((await post('provider', 'tailscale')).status, 200);
  assert.equal((await post('login')).status, 200);
  assert.equal((await post('open-app')).status, 200);
  assert.deepEqual(calls, ['tailscale', 'login', 'open-app']);
});
