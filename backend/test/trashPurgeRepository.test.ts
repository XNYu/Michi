/**
 * Tests for repository-level trash purge functions used by the Empty Trash
 * feature. We test the repository layer (not the route handlers) because the
 * routes are thin wrappers — verifying the SQL semantics here is sufficient
 * and avoids spinning up Express.
 *
 * Uses node:test (Node 22+ built-in) with a fresh MICHI_DATA_DIR per test so
 * each case starts from a freshly-migrated SQLite file.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb } from '../src/services/db';
import {
  saveWorkspace, saveTree, saveNode, saveEdge, saveMessage,
  listNodes, listEdges, listMessages, listTrees,
  emptyWorkspaceTrash, purgeWorkspaceNodes,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-trash-test-'));
}

interface NodeOpts {
  deletedAt?: number;
  groupId?: string;
  parent?: string;
  tree?: string;
}

function insertWorkspace(wsId: string) {
  saveWorkspace({
    id: wsId, name: 'test', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
  });
}

function insertNode(wsId: string, id: string, opts: NodeOpts = {}) {
  saveNode({
    id, workspace_id: wsId,
    tree_id: opts.tree ?? null,
    parent_node_id: opts.parent ?? null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: opts.deletedAt ?? null,
    deletion_group_id: opts.groupId ?? null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, acp_session_id: null,
    runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    created_at: 1,
  });
}

function insertTree(wsId: string, id: string, rootNodeId: string) {
  saveTree({
    id, workspace_id: wsId, root_node_id: rootNodeId,
    name: null, archived_at: null, pinned_at: null,
    last_active_at: 1, created_at: 1,
  });
}

describe('emptyWorkspaceTrash', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removes only soft-deleted nodes and returns the count', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'live1');
    insertNode('ws1', 'live2');
    insertNode('ws1', 'dead1', { deletedAt: 100, groupId: 'g1' });
    insertNode('ws1', 'dead2', { deletedAt: 100, groupId: 'g1' });

    const purged = emptyWorkspaceTrash('ws1');

    assert.equal(purged, 2);
    const remaining = listNodes('ws1').map((n) => n.id).sort();
    assert.deepEqual(remaining, ['live1', 'live2']);
  });

  test('cascades edges and messages of deleted nodes', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'live1');
    insertNode('ws1', 'dead1', { deletedAt: 100, groupId: 'g1' });
    saveEdge({
      id: 'e-live-dead', workspace_id: 'ws1',
      source_node_id: 'live1', target_node_id: 'dead1', kind: 'branch',
    });
    saveMessage({
      id: 'm-dead-1', node_id: 'dead1', role: 'user',
      content: 'hi', blocks: null, tool_calls: null, seq: 0, created_at: 1,
    });
    saveMessage({
      id: 'm-live-1', node_id: 'live1', role: 'user',
      content: 'kept', blocks: null, tool_calls: null, seq: 0, created_at: 1,
    });

    emptyWorkspaceTrash('ws1');

    assert.equal(listEdges('ws1').length, 0, 'edge touching dead1 was cascaded');
    assert.equal(listMessages('dead1').length, 0, 'dead1 messages cascaded');
    assert.equal(listMessages('live1').length, 1, 'live1 messages preserved');
  });

  test('drops trees whose root no longer exists', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'live-root');
    insertNode('ws1', 'dead-root', { deletedAt: 100, groupId: 'g1' });
    insertTree('ws1', 't-live', 'live-root');
    insertTree('ws1', 't-dead', 'dead-root');

    emptyWorkspaceTrash('ws1');

    const trees = listTrees('ws1').map((t) => t.id).sort();
    assert.deepEqual(trees, ['t-live']);
  });

  test('is scoped to the requested workspace only', () => {
    insertWorkspace('ws1');
    insertWorkspace('ws2');
    insertNode('ws1', 'dead-in-ws1', { deletedAt: 100, groupId: 'g1' });
    insertNode('ws2', 'dead-in-ws2', { deletedAt: 100, groupId: 'g2' });

    const purged = emptyWorkspaceTrash('ws1');

    assert.equal(purged, 1);
    assert.equal(listNodes('ws2').length, 1, 'ws2 untouched');
  });

  test('is a no-op when there is nothing to purge', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'live');

    const purged = emptyWorkspaceTrash('ws1');

    assert.equal(purged, 0);
    assert.equal(listNodes('ws1').length, 1);
  });
});

describe('purgeWorkspaceNodes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removes only listed ids and returns the count', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'a', { deletedAt: 100, groupId: 'g1' });
    insertNode('ws1', 'b', { deletedAt: 100, groupId: 'g1' });
    insertNode('ws1', 'c', { deletedAt: 100, groupId: 'g2' });

    const purged = purgeWorkspaceNodes('ws1', ['a', 'b']);

    assert.equal(purged, 2);
    const remaining = listNodes('ws1').map((n) => n.id);
    assert.deepEqual(remaining, ['c']);
  });

  test('is a no-op for an empty list', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'a');

    const purged = purgeWorkspaceNodes('ws1', []);

    assert.equal(purged, 0);
    assert.equal(listNodes('ws1').length, 1);
  });

  test('does not delete nodes from a different workspace', () => {
    insertWorkspace('ws1');
    insertWorkspace('ws2');
    insertNode('ws1', 'shared');
    insertNode('ws2', 'other');

    // Caller mistakenly includes a node id from ws2 while purging in ws1.
    const purged = purgeWorkspaceNodes('ws1', ['shared', 'other']);

    assert.equal(purged, 1, 'only the ws1-scoped row was deleted');
    assert.equal(listNodes('ws2').length, 1, 'ws2 row untouched');
  });

  test('drops orphaned trees alongside the targeted nodes', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'root-a');
    insertNode('ws1', 'root-b');
    insertTree('ws1', 't-a', 'root-a');
    insertTree('ws1', 't-b', 'root-b');

    purgeWorkspaceNodes('ws1', ['root-a']);

    const trees = listTrees('ws1').map((t) => t.id);
    assert.deepEqual(trees, ['t-b']);
  });
});
