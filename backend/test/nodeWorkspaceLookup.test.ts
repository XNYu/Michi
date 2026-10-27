/**
 * GET /nodes/:nodeId/workspace: which workspace (and thread) holds a live
 * node, so a window can load one thread it doesn't have yet (an assistant
 * link to a thread made in another window) without reading every workspace.
 * Deleted nodes and deleted workspaces are not found; in cloud mode another
 * owner's node is not found either.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { setupPersistenceRoutes } from '../src/routes/persistence';

let tmpDir: string;
let server: http.Server;
let baseUrl: string;

function seed(): void {
  for (const [id, deletedAt] of [['ws-a', null], ['ws-gone', 5]] as const) {
    saveWorkspace({ id, name: id, cwd: null, created_at: 1, updated_at: 1, settings: null });
    if (deletedAt) getDb().prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(deletedAt, id);
  }
  getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run('owner', 'ws-a');
  getDb().prepare(`INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at)
    VALUES ('t-a', 'ws-a', 'n-live', 1, 1)`).run();
  const insert = getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, minimized, spawned_by_agent, created_at, deleted_at)
    VALUES (?, ?, ?, 'chat', 'idle', 0, 0, 1, ?)`);
  insert.run('n-live', 'ws-a', 't-a', null);
  insert.run('n-deleted', 'ws-a', 't-a', 7);
  insert.run('n-in-gone', 'ws-gone', null, null);
}

async function lookup(nodeId: string, user?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/nodes/${encodeURIComponent(nodeId)}/workspace`, {
    headers: user ? { 'x-test-user': user } : {},
  });
  return { status: res.status, body: await res.json() };
}

describe('GET /nodes/:nodeId/workspace', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-node-lookup-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seed();
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const user = req.headers['x-test-user'];
      if (user) req.user = { id: user };
      next();
    });
    app.use('/api', setupPersistenceRoutes());
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.MICHI_CLOUD;
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('names the workspace and thread of a live node', async () => {
    assert.deepEqual(await lookup('n-live'), { status: 200, body: { workspaceId: 'ws-a', treeId: 't-a' } });
  });

  test('finds no deleted node, no node of a deleted workspace and no unknown id', async () => {
    for (const id of ['n-deleted', 'n-in-gone', 'n-unknown']) {
      assert.equal((await lookup(id)).status, 404, id);
    }
  });

  test('refuses a malformed id before looking anything up', async () => {
    process.env.MICHI_CLOUD = '1';
    for (const id of ['a b', 'x'.repeat(129), '../n-live', 'n-live;']) {
      assert.equal((await lookup(id, 'owner')).status, 400, JSON.stringify(id));
    }
  });

  test('in cloud mode answers the owner only', async () => {
    process.env.MICHI_CLOUD = '1';
    assert.equal((await lookup('n-live', 'someone-else')).status, 404);
    assert.equal((await lookup('n-live', 'owner')).status, 200);
  });
});
