import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setupPersistenceRoutes } from '../src/routes/persistence';

import { closeDb, initDb } from '../src/services/db';
import {
  saveWorkspace,
  saveTree,
  saveNode,
  saveMessage,
  loadAllWorkspacesMeta,
  loadWorkspaceMeta,
  loadTreeMessages,
  loadTreeMessagePage,
} from '../src/services/dbRepository';

function seedNode(id: string, workspaceId: string, treeId: string): void {
  saveNode({
    id, workspace_id: workspaceId, tree_id: treeId, parent_node_id: null,
    kind: 'chat', title: null, branch_overview: null, status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null,
    follow_ups_source_message_id: null, acp_session_id: null, runtime_id: null,
    provider_id: null, model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
  });
}

function seedMessage(id: string, nodeId: string, seq: number, content: string): void {
  saveMessage({
    id, node_id: nodeId, role: seq % 2 === 0 ? 'user' : 'assistant',
    content, blocks: null, tool_calls: null, metadata: null, seq, created_at: seq,
  });
}

describe('lazy-load repository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-lazyload-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();

    // ws-1: two trees. tree-A has 2 nodes (3 msgs total), tree-B has 1 node (2 msgs).
    saveWorkspace({
      id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1,
      active_tree_id: 'tree-A', cwd: null, settings: null,
    });
    saveTree({ id: 'tree-A', workspace_id: 'ws-1', root_node_id: 'n-a1', name: null, archived_at: null, pinned_at: null, last_active_at: 2, created_at: 1 });
    saveTree({ id: 'tree-B', workspace_id: 'ws-1', root_node_id: 'n-b1', name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1 });
    seedNode('n-a1', 'ws-1', 'tree-A');
    seedNode('n-a2', 'ws-1', 'tree-A');
    seedNode('n-b1', 'ws-1', 'tree-B');
    seedMessage('m-a1-0', 'n-a1', 0, 'alpha hello');
    seedMessage('m-a1-1', 'n-a1', 1, 'alpha reply');
    seedMessage('m-a2-0', 'n-a2', 0, 'beta hello');
    seedMessage('m-b1-0', 'n-b1', 0, 'gamma hello');
    seedMessage('m-b1-1', 'n-b1', 1, 'gamma reply');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('meta payload carries structure + message_count but NO message bodies', () => {
    const all = loadAllWorkspacesMeta();
    assert.equal(all.length, 1);
    const ws = all[0];
    assert.equal(ws.workspace.id, 'ws-1');
    assert.equal(ws.trees.length, 2);
    assert.equal(ws.nodes.length, 3);
    // The whole point: no bodies inline.
    assert.deepEqual(ws.messages, []);
    // Counts ride on each node row.
    const byId = new Map(ws.nodes.map(n => [n.id, n.message_count]));
    assert.equal(byId.get('n-a1'), 2);
    assert.equal(byId.get('n-a2'), 1);
    assert.equal(byId.get('n-b1'), 2);
  });

  test('a node with zero messages reports message_count 0 (not undefined)', () => {
    seedNode('n-empty', 'ws-1', 'tree-B');
    const meta = loadWorkspaceMeta('ws-1')!;
    const empty = meta.nodes.find(n => n.id === 'n-empty')!;
    assert.equal(empty.message_count, 0);
  });

  test('loadTreeMessages for an unknown tree is empty, not an error', () => {
    assert.deepEqual(loadTreeMessages('ws-1', 'tree-nope'), []);
  });

  test('pages each node from its newest messages and continues without duplicates after new output', () => {
    for (let seq = 2; seq < 120; seq++) seedMessage(`m-a1-${seq}`, 'n-a1', seq, `message ${seq}`);
    const first = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50 });
    const cursor = first.pages.find(page => page.nodeId === 'n-a1')!;
    assert.equal(cursor.total, 120);
    assert.equal(first.messages.filter(row => row.node_id === 'n-a1').length, 50);
    assert.equal(first.messages.find(row => row.node_id === 'n-a1')?.seq, 70);
    assert.equal(first.pages.find(page => page.nodeId === 'n-a2')?.before, null);
    assert.ok(first.messages.every(row => row.node_id !== 'n-b1'));
    seedMessage('new', 'n-a1', 120, 'arrived between pages');
    const second = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', before: cursor.before! });
    assert.equal(second.messages[0].seq, 20);
    assert.equal(second.messages.at(-1)?.seq, 69);
    const last = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', before: second.pages[0].before! });
    assert.equal(last.messages.length, 20);
    assert.equal(last.pages[0].before, null);
    assert.equal(new Set([...last.messages, ...second.messages, ...first.messages.filter(row => row.node_id === 'n-a1')].map(row => row.id)).size, 120);
  });

  test('isolates page cursors by workspace and tree, including empty nodes', () => {
    assert.deepEqual(loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-b1' }), { messages: [], pages: [] });
    assert.deepEqual(loadTreeMessagePage('other', 'tree-A', { limit: 50 }), { messages: [], pages: [] });
    seedNode('empty', 'ws-1', 'tree-A');
    assert.deepEqual(loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'empty' }), {
      messages: [], pages: [{ nodeId: 'empty', total: 0, before: null }],
    });
  });

  test('enforces cloud ownership for page reads', () => {
    const old = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = '1';
    try {
      saveWorkspace({ id: 'owned', name: 'Owned', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
      saveTree({ id: 'tree', workspace_id: 'owned', root_node_id: 'secret', name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1 });
      seedNode('secret', 'owned', 'tree'); seedMessage('secret-row', 'secret', 0, 'private');
      assert.equal(loadTreeMessagePage('owned', 'tree', { limit: 50 }, 'alice').messages.length, 1);
      assert.deepEqual(loadTreeMessagePage('owned', 'tree', { limit: 50 }, 'bob'), { messages: [], pages: [] });
    } finally { if (old === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = old; }
  });

  test('HTTP pages validate cursors, preserve full-history compatibility and enforce ownership', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'bob' } as typeof req.user; next(); });
    app.use('/api', setupPersistenceRoutes());
    const server = app.listen(0, '127.0.0.1');
    const oldCloud = process.env.MICHI_CLOUD;
    try {
      await once(server, 'listening');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws-1/trees/tree-A/messages`;
      const recent = await fetch(`${url}?limit=1`);
      assert.equal(recent.status, 200);
      assert.equal(recent.headers.get('cache-control'), 'no-store');
      const page = await recent.json() as ReturnType<typeof loadTreeMessagePage>;
      assert.equal(page.messages.length, 2); // One per node in this tree.
      assert.deepEqual(page.pages.find(item => item.nodeId === 'n-a1')?.before, { seq: 1, id: 'm-a1-1' });
      const older = await fetch(`${url}?limit=1&nodeId=n-a1&beforeSeq=1&beforeId=m-a1-1`);
      assert.equal((await older.json() as ReturnType<typeof loadTreeMessagePage>).messages[0].id, 'm-a1-0');
      const all = await fetch(url);
      assert.equal((await all.json() as { messages: unknown[] }).messages.length, 3);
      for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'limit=1&limit=2',
        'limit=1&beforeSeq=1&beforeId=m-a1-1', 'limit=1&nodeId=n-a1&beforeSeq=1',
        'limit=1&nodeId=n-a1&beforeId=m-a1-1', 'limit=1&nodeId=n-a1&beforeSeq=-1&beforeId=m-a1-1']) {
        const response = await fetch(`${url}?${query}`);
        assert.equal(response.status, 400, query);
        await response.body?.cancel();
      }
      process.env.MICHI_CLOUD = '1';
      const denied = await fetch(`${url}?limit=1`);
      assert.equal(denied.status, 404);
      await denied.body?.cancel();
    } finally {
      if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
