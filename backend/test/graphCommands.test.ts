import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initDb } from '../src/services/db';
import { ensureDurableGraphNode } from '../src/services/graphCommands';
import { getNode, getWorkspace, listEdges, listTrees, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';

describe('ensureDurableGraphNode', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-graph-command-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('atomically creates and idempotently replays workspace/tree/node/edge prerequisites', () => {
    const root = ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', cwd: null, createdAt: 1, activeTreeId: 'tree-1' },
      tree: { id: 'tree-1', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 },
      node: { id: 'root', treeId: 'tree-1', parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    });
    const childInput = {
      workspace: { id: 'ws-1', name: 'Workspace', cwd: null, createdAt: 1, activeTreeId: 'tree-1' },
      tree: { id: 'tree-1', rootNodeId: 'root', createdAt: 1, lastActiveAt: 2 },
      node: { id: 'child', treeId: 'tree-1', parentNodeId: 'root', kind: 'chat', createdAt: 2 },
      edges: [{ id: 'branch-root-child', sourceNodeId: 'root', targetNodeId: 'child', kind: 'branch', createdAt: 2 }],
    } as const;
    const child = ensureDurableGraphNode(childInput);
    const replay = ensureDurableGraphNode(childInput);

    assert.equal(root.node.id, 'root');
    assert.equal(child.node.id, 'child');
    assert.equal(replay.node.id, 'child');
    assert.equal(getWorkspace('ws-1')?.id, 'ws-1');
    assert.equal(listTrees('ws-1').length, 1);
    assert.equal(getNode('child')?.parent_node_id, 'root');
    assert.equal(listEdges('ws-1').length, 1);
  });

  test('rejects a branch whose parent belongs to another workspace without partial writes', () => {
    saveWorkspace({ id: 'other', name: 'Other', created_at: 1, updated_at: 1 });
    saveNode({
      id: 'foreign-parent', workspace_id: 'other', tree_id: null, parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });

    assert.throws(() => ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', cwd: null, createdAt: 1, activeTreeId: null },
      node: { id: 'child', treeId: null, parentNodeId: 'foreign-parent', kind: 'chat', createdAt: 2 },
      edges: [{ id: 'branch-foreign-child', sourceNodeId: 'foreign-parent', targetNodeId: 'child', kind: 'branch', createdAt: 2 }],
    }), /same workspace/i);
    assert.equal(getNode('child'), null);
  });

  test('preserves existing workspace fields while ensuring a durable node', () => {
    saveWorkspace({
      id: 'ws-1', name: 'Workspace', cwd: '/original', created_at: 1, updated_at: 1,
      settings: '{"custom":true}', deleted_at: 10, archived_at: 11, pinned_at: 12,
      backend: 'claude',
    });
    saveNode({
      id: 'root', workspace_id: 'ws-1', tree_id: null, parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });

    ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', cwd: '/original', createdAt: 1, activeTreeId: null },
      node: { id: 'root', treeId: null, parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    });

    const workspace = getWorkspace('ws-1');
    assert.equal(workspace?.settings, '{"custom":true}');
    assert.equal(workspace?.deleted_at, 10);
    assert.equal(workspace?.archived_at, 11);
    assert.equal(workspace?.pinned_at, 12);
    assert.equal(workspace?.backend, 'claude');
  });

  test('rejects a tree id that already belongs to another workspace', () => {
    saveWorkspace({ id: 'other', name: 'Other', created_at: 1, updated_at: 1 });
    saveTree({
      id: 'tree-shared', workspace_id: 'other', root_node_id: 'foreign-root',
      name: 'Foreign tree', last_active_at: 1, created_at: 1,
    });
    saveNode({
      id: 'foreign-root', workspace_id: 'other', tree_id: 'tree-shared', parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });

    assert.throws(() => ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', createdAt: 1, activeTreeId: 'tree-shared' },
      tree: { id: 'tree-shared', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 },
      node: { id: 'root', treeId: 'tree-shared', parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    }), /different workspace/i);

    assert.equal(getNode('root'), null);
    assert.equal(listTrees('other')[0]?.name, 'Foreign tree');
  });

  test('rejects a tree root that belongs to another workspace', () => {
    saveWorkspace({ id: 'other', name: 'Other', created_at: 1, updated_at: 1 });
    saveNode({
      id: 'foreign-root', workspace_id: 'other', tree_id: null, parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });

    assert.throws(() => ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', createdAt: 1, activeTreeId: 'tree-1' },
      tree: { id: 'tree-1', rootNodeId: 'foreign-root', createdAt: 1, lastActiveAt: 1 },
      node: { id: 'local-node', treeId: 'tree-1', parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    }), /root.*same workspace/i);

    assert.equal(getNode('local-node'), null);
    assert.equal(getWorkspace('ws-1'), null);
  });

  test('rejects foreign node and active-tree references when the tree payload is omitted', () => {
    saveWorkspace({ id: 'other', name: 'Other', created_at: 1, updated_at: 1 });
    saveTree({
      id: 'foreign-tree', workspace_id: 'other', root_node_id: 'foreign-root',
      last_active_at: 1, created_at: 1,
    });
    saveNode({
      id: 'foreign-root', workspace_id: 'other', tree_id: 'foreign-tree', parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });

    assert.throws(() => ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', createdAt: 1, activeTreeId: null },
      node: { id: 'local-node', treeId: 'foreign-tree', parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    }), /node tree.*same workspace/i);
    assert.throws(() => ensureDurableGraphNode({
      workspace: { id: 'ws-1', name: 'Workspace', createdAt: 1, activeTreeId: 'foreign-tree' },
      node: { id: 'local-root', treeId: null, parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    }), /active tree.*same workspace/i);

    assert.equal(getWorkspace('ws-1'), null);
    assert.equal(getNode('local-node'), null);
    assert.equal(getNode('local-root'), null);
  });
});
