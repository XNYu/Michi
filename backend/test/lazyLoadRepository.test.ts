import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initDb } from '../src/services/db';
import {
  saveWorkspace,
  saveTree,
  saveNode,
  saveMessage,
  loadAllWorkspacesMeta,
  loadWorkspaceMeta,
  loadTreeMessages,
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

  test('loadTreeMessages returns ONLY the requested tree, ordered by node then seq', () => {
    const treeA = loadTreeMessages('ws-1', 'tree-A');
    assert.deepEqual(treeA.map(m => m.id), ['m-a1-0', 'm-a1-1', 'm-a2-0']);

    const treeB = loadTreeMessages('ws-1', 'tree-B');
    assert.deepEqual(treeB.map(m => m.id), ['m-b1-0', 'm-b1-1']);

    // Cross-tree isolation: tree-A fetch never includes tree-B bodies.
    assert.ok(treeA.every(m => m.node_id !== 'n-b1'));
  });

  test('loadTreeMessages for an unknown tree is empty, not an error', () => {
    assert.deepEqual(loadTreeMessages('ws-1', 'tree-nope'), []);
  });
});
