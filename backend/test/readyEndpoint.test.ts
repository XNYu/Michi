import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getWarmStatus, markReady, __resetWarmStatusForTest } from '../src/services/readyState';

function makeApp(): express.Express {
  const app = express();
  app.get('/api/ready', (_req, res) => res.json(getWarmStatus()));
  return app;
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
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

  test('returns ready after markReady', async () => {
    markReady();
    const app = makeApp();
    const { body } = await get(app, '/api/ready');
    assert.equal(body.status, 'ready');
  });
});
