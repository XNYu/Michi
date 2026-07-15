import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { initDb, closeDb } from '../src/services/db';
import { setupPersistenceRoutes } from '../src/routes/persistence';

describe('POST /workspaces/:id/sync — removed legacy writer', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sync-disabled-test-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();

    const app = express();
    app.use(express.json());
    app.use('/api', setupPersistenceRoutes());
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rejects every legacy snapshot without mutating workspace state', async () => {
    const response = await fetch(`${baseUrl}/workspaces/ws1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: { id: 'ws1', name: 'must-not-be-created' },
        trees: [], nodes: [], edges: [], messages: [], contexts: [],
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 410);
    assert.equal(body.error, 'legacy_workspace_sync_disabled');
    assert.equal(body.reloadRequired, true);
    assert.equal(body.protocolVersion, 2);

    const workspaceResponse = await fetch(`${baseUrl}/workspaces/ws1`);
    assert.equal(workspaceResponse.status, 404);
  });

  test('advertises that legacy sync is unavailable', async () => {
    const response = await fetch(`${baseUrl}/persistence/capabilities`);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.protocolVersion, 2);
    assert.equal(body.backgroundWorkspaceSync, false);
    assert.equal(body.legacySyncAccepted, false);
  });
});
