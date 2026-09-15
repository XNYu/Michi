/**
 * P2-5 capability discovery: GET /persistence/capabilities must advertise the
 * optional `paneInspection: 'v1'` field alongside the existing capabilities,
 * so a frontend probing an OLD gateway (a server predating this field) can
 * tell "unsupported" apart from "supported but reports zero panes" (design
 * doc §11: "旧 gateway 没有该能力时显示 unsupported，不返回空列表冒充没有 pane").
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { setupPersistenceRoutes } from '../src/routes/persistence';

describe('GET /persistence/capabilities — paneInspection capability', () => {
  async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/api', setupPersistenceRoutes());
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      await fn(`http://127.0.0.1:${port}/api`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('advertises paneInspection: "v1" alongside existing capabilities', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/persistence/capabilities`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.paneInspection, 'v1');
      // Existing fields must be untouched by this addition.
      assert.equal(body.protocolVersion, 2);
      assert.equal(body.streamTransport, 'websocket-v1');
    });
  });
});
