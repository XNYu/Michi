import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { JsonConfigError } from '../src/services/jsonConfigStore';
import { handleJsonConfigError, jsonConfigErrorResponse } from '../src/routes/jsonConfigErrorResponse';
const originalCloud = process.env.MICHI_CLOUD;
afterEach(() => { if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud; });

test('config errors retain stable HTTP codes and local diagnostics without exposing cloud paths', async () => {
  for (const cloud of [false, true]) {
    if (cloud) process.env.MICHI_CLOUD = '1'; else delete process.env.MICHI_CLOUD;
    const app = express();
    app.get('/:code', (req, _res) => { throw new JsonConfigError('/private/operator/config.json', 'write', new Error('fixture'), req.params.code as JsonConfigError['code']); });
    app.use(handleJsonConfigError);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      for (const code of ['CONFIG_LOCKED', 'CONFIG_CORRUPT', 'CONFIG_READ_FAILED', 'CONFIG_WRITE_FAILED']) {
        const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${code}`);
        assert.equal(result.status, 500); const body = await result.json() as { error: string; code: string };
        assert.equal(body.code, code); assert.equal(body.error.includes('/private/operator'), !cloud);
      }
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test('unknown errors remain owned by the final handler and partial responses are delegated', () => {
  assert.equal(jsonConfigErrorResponse(new Error('unexpected')), null);
  const error = new JsonConfigError('/fixture/config.json', 'write', new Error('fixture'));
  let delegated: unknown; let responded = false;
  handleJsonConfigError(error, {} as any, { headersSent: true, status: () => { responded = true; } } as any, (nextError) => { delegated = nextError; });
  assert.equal(delegated, error); assert.equal(responded, false);
});
