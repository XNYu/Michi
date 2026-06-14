import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  getWarmStatus,
  markReady,
  markFailed,
  __resetWarmStatusForTest,
} from '../src/services/readyState';

function makeApp(): express.Express {
  const app = express();
  app.get('/api/ready', (_req, res) => res.json(getWarmStatus()));
  return app;
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = (server.address() as any).port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        const body = await r.json();
        server.close();
        resolve({ status: r.status, body });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

describe('/api/ready endpoint', () => {
  beforeEach(() => __resetWarmStatusForTest());

  test('returns pending immediately', async () => {
    const app = makeApp();
    const { status, body } = await get(app, '/api/ready');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'pending', error: null });
  });

  test('returns ready after markReady', async () => {
    markReady();
    const app = makeApp();
    const { body } = await get(app, '/api/ready');
    assert.equal(body.status, 'ready');
  });

  test('returns failed with error message after markFailed', async () => {
    markFailed(new Error('kiro-cli ENOENT'));
    const app = makeApp();
    const { body } = await get(app, '/api/ready');
    assert.equal(body.status, 'failed');
    assert.equal(body.error, 'kiro-cli ENOENT');
  });

  test('handler completes in under 50ms (no runtime calls)', async () => {
    const app = makeApp();
    const t0 = Date.now();
    await get(app, '/api/ready');
    const dur = Date.now() - t0;
    assert.ok(dur < 50, `endpoint took ${dur}ms, expected <50ms`);
  });
});
