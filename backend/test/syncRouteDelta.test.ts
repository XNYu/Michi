/**
 * Route-level integration tests for the `POST /workspaces/:id/sync` delta path.
 *
 * These tests drive the Express handler over real HTTP (listen on an ephemeral
 * port) so they catch field-forwarding bugs that unit tests miss — e.g. a
 * destructure in the route handler that drops a field before passing it to the
 * repo function.
 *
 * Harness: fresh MICHI_DATA_DIR per test (same pattern as the repo tests),
 * express app spun up with `setupPersistenceRoutes()`, torn down in afterEach.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  saveWorkspace, saveNode, saveMessage,
  listMessages,
  WorkspaceRow, NodeRow, MessageRow,
} from '../src/services/dbRepository';
import { setupPersistenceRoutes } from '../src/routes/persistence';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-routedelta-test-'));
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

function makeMessage(nodeId: string, id: string): MessageRow {
  return {
    id, node_id: nodeId, role: 'user',
    content: 'hello', blocks: null, tool_calls: null, seq: 0, created_at: 1,
  };
}

describe('POST /workspaces/:id/sync — delta route forwarding', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen>;
  let port: number;
  let baseUrl: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();

    const app = express();
    app.use(express.json());
    app.use('/api', setupPersistenceRoutes());
    server = app.listen(0);
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function postSync(workspaceId: string, body: unknown): Promise<{ ok: boolean; ignored?: string }> {
    const r = await fetch(`${baseUrl}/workspaces/${workspaceId}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json() as Promise<{ ok: boolean; ignored?: string }>;
  }

  test('messageReconcileNodeIds forwarded: node with zero remaining messages is wiped over HTTP', async () => {
    // Seed workspace + node + 2 messages directly via repo (bypasses HTTP for
    // setup speed, focusing the HTTP path on the forwarding under test).
    saveWorkspace(makeWorkspace('ws1'));
    saveNode(makeNode('ws1', 'n1'));
    saveMessage(makeMessage('n1', 'msg-a'));
    saveMessage({ ...makeMessage('n1', 'msg-b'), seq: 1 });
    assert.equal(listMessages('n1').length, 2);

    // POST a delta that declares n1 authoritative-but-empty via
    // messageReconcileNodeIds (no upserts.messages for n1).
    // Before the fix this field was dropped by the route destructure and the
    // messages would survive. After the fix they must be wiped.
    const res = await postSync('ws1', {
      mode: 'delta',
      upserts: { nodes: [makeNode('ws1', 'n1')] },
      messageReconcileNodeIds: ['n1'],
      // intentionally NO upserts.messages
    });

    assert.equal(res.ok, true);
    // The field reached syncWorkspaceDelta: n1's messages are now empty.
    assert.equal(listMessages('n1').length, 0,
      'messageReconcileNodeIds must be forwarded by the route — messages should be wiped');
  });

  test('positive control: delta WITHOUT messageReconcileNodeIds leaves messages intact', async () => {
    // Same seed as above but no messageReconcileNodeIds in the delta body.
    saveWorkspace(makeWorkspace('ws1'));
    saveNode(makeNode('ws1', 'n1'));
    saveMessage(makeMessage('n1', 'msg-a'));
    saveMessage({ ...makeMessage('n1', 'msg-b'), seq: 1 });
    assert.equal(listMessages('n1').length, 2);

    const res = await postSync('ws1', {
      mode: 'delta',
      upserts: { nodes: [makeNode('ws1', 'n1')] },
      // no messageReconcileNodeIds, no upserts.messages → messages untouched
    });

    assert.equal(res.ok, true);
    assert.equal(listMessages('n1').length, 2,
      'without messageReconcileNodeIds the messages must be untouched');
  });

  test('full-sync mode still works after the delta branch change', async () => {
    // Smoke-test that the else-branch (full reconcile) is unaffected.
    const res = await postSync('ws1', {
      // no mode → full path
      workspace: makeWorkspace('ws1'),
      trees: [],
      nodes: [makeNode('ws1', 'n1')],
      edges: [],
      messages: [makeMessage('n1', 'msg-a')],
      contexts: [],
    });
    assert.equal(res.ok, true);
    assert.equal(listMessages('n1').length, 1);
  });

  test('v2 workspace rejects a stale legacy sync before it can overwrite messages', async () => {
    saveWorkspace(makeWorkspace('ws1'));
    saveNode(makeNode('ws1', 'n1'));
    saveMessage(makeMessage('n1', 'msg-a'));
    getDb().prepare('UPDATE workspaces SET persistence_version = 2 WHERE id = ?').run('ws1');

    const response = await fetch(`${baseUrl}/workspaces/ws1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'delta',
        upserts: { nodes: [makeNode('ws1', 'n1')] },
        messageReconcileNodeIds: ['n1'],
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 409);
    assert.equal(body.error, 'persistence_v2_reload_required');
    assert.equal(listMessages('n1').length, 1);
  });

  test('tombstoned workspace: delta returns ok+ignored over HTTP', async () => {
    // Seed then tombstone via a full sync delete.
    saveWorkspace(makeWorkspace('ws1'));
    saveNode(makeNode('ws1', 'n1'));
    // Tombstone by syncing with purged_at set is not directly possible via the
    // route; use deleteWorkspace from repo to set purged_at.
    const { deleteWorkspace } = await import('../src/services/dbRepository');
    deleteWorkspace('ws1');

    const res = await postSync('ws1', {
      mode: 'delta',
      upserts: { nodes: [makeNode('ws1', 'n1')] },
      messageReconcileNodeIds: ['n1'],
    });

    assert.equal(res.ok, true);
    assert.equal(res.ignored, 'workspace tombstoned');
  });
});
