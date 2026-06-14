/**
 * Regression test for the trash/purge IDOR (Insecure Direct Object Reference).
 *
 * In cloud mode these destructive routes must reject callers who do not own
 * the target workspace (returns 404 to hide existence, same as other routes):
 *   - POST /workspaces/:id/trash/empty
 *   - DELETE /workspaces/:id/nodes
 *   - POST /workspaces/:id/nodes/:nodeId/trim
 *   - POST /workspaces/:id/nodes/:nodeId/restore-trim
 *
 * Before the fix these routes had no requireWorkspaceOwner middleware, letting
 * any authenticated user call them on any workspace id.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { initDb, closeDb } from '../src/services/db';
import { saveWorkspace, saveNode } from '../src/services/dbRepository';
import type { WorkspaceRow, NodeRow } from '../src/services/dbRepository';
import { setupPersistenceRoutes } from '../src/routes/persistence';

const OWNER_ID = 'user-owner-aaa';
const ATTACKER_ID = 'user-attacker-bbb';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-idor-test-'));
}

function makeWorkspace(id: string): WorkspaceRow {
  return {
    id, name: 'test', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
  };
}

function makeNode(wsId: string, id: string): NodeRow {
  return {
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: null, deletion_group_id: null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, acp_session_id: null,
    runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    created_at: 1,
  };
}

describe('Cloud-mode IDOR: trash/purge routes reject non-owner', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen>;
  let port: number;
  let baseUrl: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    process.env.MICHI_CLOUD = '1';
    closeDb();
    initDb();

    // Seed workspace owned by OWNER_ID
    saveWorkspace(makeWorkspace('ws-victim'));
    const { getDb } = require('../src/services/db');
    getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run(OWNER_ID, 'ws-victim');

    saveNode(makeNode('ws-victim', 'node1'));

    const app = express();
    app.use(express.json());
    // Inject fake auth: X-Test-User header sets req.user.id
    app.use((req: any, _res, next) => {
      const userId = req.headers['x-test-user'];
      if (userId) req.user = { id: userId };
      next();
    });
    app.use('/api', setupPersistenceRoutes());
    server = app.listen(0);
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MICHI_CLOUD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function req(method: string, urlPath: string, userId: string, body?: unknown) {
    const opts: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': userId },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(`${baseUrl}${urlPath}`, opts);
  }

  test('POST /trash/empty — owner succeeds, attacker gets 404', async () => {
    const ok = await req('POST', '/workspaces/ws-victim/trash/empty', OWNER_ID);
    assert.equal(ok.status, 200, 'owner should succeed');

    const bad = await req('POST', '/workspaces/ws-victim/trash/empty', ATTACKER_ID);
    assert.equal(bad.status, 404, 'non-owner must get 404');
  });

  test('DELETE /nodes — owner succeeds, attacker gets 404', async () => {
    const ok = await req('DELETE', '/workspaces/ws-victim/nodes', OWNER_ID, { nodeIds: [] });
    assert.equal(ok.status, 200, 'owner should succeed');

    const bad = await req('DELETE', '/workspaces/ws-victim/nodes', ATTACKER_ID, { nodeIds: ['node1'] });
    assert.equal(bad.status, 404, 'non-owner must get 404');
  });

  test('POST /trim — owner succeeds, attacker gets 404', async () => {
    const body = { deletedAt: Date.now(), groupId: 'g1' };
    const ok = await req('POST', '/workspaces/ws-victim/nodes/node1/trim', OWNER_ID, body);
    assert.equal(ok.status, 200, 'owner should succeed');

    const bad = await req('POST', '/workspaces/ws-victim/nodes/node1/trim', ATTACKER_ID, body);
    assert.equal(bad.status, 404, 'non-owner must get 404');
  });

  test('POST /restore-trim — owner succeeds, attacker gets 404', async () => {
    const ok = await req('POST', '/workspaces/ws-victim/nodes/node1/restore-trim', OWNER_ID);
    assert.equal(ok.status, 200, 'owner should succeed');

    const bad = await req('POST', '/workspaces/ws-victim/nodes/node1/restore-trim', ATTACKER_ID);
    assert.equal(bad.status, 404, 'non-owner must get 404');
  });
});
