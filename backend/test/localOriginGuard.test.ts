import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createLocalOriginGuard,
  isLocalHostHeader,
  isTrustedRendererOrigin,
} from '../src/routes/middleware/localControl';
import { isAllowedLocalOrigin } from '../src/services/localOrigins';

/** `npm run dev`'s watch build sets MICHI_DEV_RENDERER=1; only then is the Vite renderer on loopback :3001 trusted (services/localOrigins.ts). */
function withDevRenderer(t: { after: (fn: () => void) => void }): void {
  const previous = process.env.MICHI_DEV_RENDERER;
  process.env.MICHI_DEV_RENDERER = '1';
  t.after(() => { if (previous === undefined) delete process.env.MICHI_DEV_RENDERER; else process.env.MICHI_DEV_RENDERER = previous; });
}

function run(headers: Record<string, string>, options: { loopbackListener?: boolean; remote?: boolean } = {}) {
  const guard = createLocalOriginGuard({ loopbackListener: options.loopbackListener ?? true });
  let status = 0;
  let nextCalled = false;
  const res = {
    locals: options.remote ? { remoteAccessAuthenticated: true } : {},
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  guard({ headers: { host: '127.0.0.1:4100', ...headers } } as Request, res, () => { nextCalled = true; });
  return nextCalled ? 'next' : status;
}

describe('createLocalOriginGuard', () => {
  test('allows requests without an Origin (runtimes, CLI, Electron main)', () => {
    assert.equal(run({}), 'next');
  });

  test('allows the same-origin renderer and, in the dev watch build, the Vite dev server', (t) => {
    assert.equal(run({ origin: 'http://127.0.0.1:4100' }), 'next');
    assert.equal(run({ origin: 'http://localhost:4100', host: 'localhost:4100' }), 'next');
    // A packaged app: another local app on :3001 is not Michi.
    assert.equal(run({ origin: 'http://localhost:3001', host: 'localhost:3000' }), 403);
    withDevRenderer(t);
    assert.equal(run({ origin: 'http://localhost:3001', host: 'localhost:3000' }), 'next');
  });

  test('rejects foreign and opaque origins', () => {
    assert.equal(run({ origin: 'https://evil.example' }), 403);
    assert.equal(run({ origin: 'null' }), 403);
    assert.equal(run({ origin: 'http://127.0.0.1:9999' }), 403);
  });

  test('rejects cross-site requests that carry no Origin', () => {
    assert.equal(run({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(run({ 'sec-fetch-site': 'same-origin' }), 'next');
  });

  test('rejects DNS-rebound hosts only on a loopback listener', () => {
    assert.equal(run({ host: 'evil.example:4100' }), 403);
    assert.equal(run({ host: 'devbox.internal:4100' }, { loopbackListener: false }), 'next');
  });

  test('token-authenticated remote requests are exempt', () => {
    assert.equal(run({ origin: 'https://evil.example', host: 'evil.example' }, { remote: true }), 'next');
  });

  test('applies the origin and host rules of services/localOrigins.ts, so the app-wide guards agree', (t) => {
    const keys = ['MICHI_CORS_ORIGINS', 'MICHI_LOCAL_CONTROL_ORIGINS', 'MICHI_ALLOWED_HOSTS'] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
    process.env.MICHI_CORS_ORIGINS = 'https://ui.example';
    process.env.MICHI_LOCAL_CONTROL_ORIGINS = 'http://127.0.0.1:5200';
    process.env.MICHI_ALLOWED_HOSTS = 'michi.tunnel.example';
    for (const origin of ['https://ui.example', 'http://127.0.0.1:5200', 'https://other.example']) {
      const req = { headers: { host: '127.0.0.1:4100' } };
      assert.equal(isTrustedRendererOrigin(req, origin), isAllowedLocalOrigin(origin, req.headers.host), origin);
    }
    assert.equal(run({ origin: 'https://ui.example' }), 'next');
    assert.equal(run({ origin: 'http://127.0.0.1:5200' }), 'next');
    // A listed tunnel name and LAN access by address pass on a loopback listener too.
    assert.equal(run({ host: 'michi.tunnel.example:4100' }), 'next');
    assert.equal(run({ host: '192.168.1.20:4100' }), 'next');
  });

  test('helpers', () => {
    assert.equal(isLocalHostHeader('[::1]:3000'), true);
    assert.equal(isLocalHostHeader(undefined), false);
    assert.equal(isTrustedRendererOrigin({ headers: { host: '127.0.0.1:3000' } }, undefined), true);
  });
});
