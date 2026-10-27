import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDbPath, initDb } from '../src/services/db';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';
import { ensureDurableGraphNode } from '../src/services/graphCommands';
import { getNode, getWorkspace, listTrees, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';

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

  test('keeps an agent-spawn title and pending prompt durable across graph replay', () => {
    ensureDurableGraphNode({
      workspace: { id: 'ws-spawn', name: 'Workspace', cwd: null, createdAt: 1, activeTreeId: 'tree-spawn' },
      tree: { id: 'tree-spawn', rootNodeId: 'root-spawn', createdAt: 1, lastActiveAt: 1 },
      node: { id: 'root-spawn', treeId: 'tree-spawn', kind: 'chat', createdAt: 1 },
      edges: [],
    });
    const child = {
      workspace: { id: 'ws-spawn', name: 'Workspace', cwd: null, createdAt: 1, activeTreeId: 'tree-spawn' },
      tree: { id: 'tree-spawn', rootNodeId: 'root-spawn', createdAt: 1, lastActiveAt: 2 },
      node: {
        id: 'child-spawn', treeId: 'tree-spawn', parentNodeId: 'root-spawn', kind: 'chat',
        title: 'Investigate durable recovery', spawnedByAgent: true,
        composerDraft: JSON.stringify({ __michiPendingSpawnPrompt: 'Continue after missed SSE' }),
        createdAt: 2,
      },
      edges: [{ id: 'branch-root-spawn-child-spawn', sourceNodeId: 'root-spawn', targetNodeId: 'child-spawn', kind: 'branch', createdAt: 2 }],
    } as const;

    ensureDurableGraphNode(child);
    ensureDurableGraphNode(child);
    const row = getNode('child-spawn');
    assert.equal(row?.title, 'Investigate durable recovery');
    assert.equal(row?.composer_draft, JSON.stringify({ __michiPendingSpawnPrompt: 'Continue after missed SSE' }));
    assert.equal(row?.spawned_by_agent, 1);
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
      backend: 'claude', folders: '[{"path":"/original"},{"path":"/second"}]',
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
    assert.equal(workspace?.folders, '[{"path":"/original"},{"path":"/second"}]');
  });

  test('the DB worker\'s graph prerequisite keeps the workspace folders too', async () => {
    saveWorkspace({ id: 'ws-w', name: 'Workspace', cwd: '/original', created_at: 1, updated_at: 1, folders: '[{"path":"/original"},{"path":"/second"}]' });
    await initDbWorker(getDbPath());
    try {
      await dbWorker.ensureDurableGraphNode({
        workspace: { id: 'ws-w', name: 'Workspace', cwd: '/original', createdAt: 1, activeTreeId: null },
        tree: { id: 'tree-w', rootNodeId: 'root-w', createdAt: 1, lastActiveAt: 1 },
        node: { id: 'root-w', treeId: 'tree-w', kind: 'chat', createdAt: 1 },
        edges: [],
      });
    } finally {
      await shutdownDbWorker();
    }
    assert.equal(getWorkspace('ws-w')?.folders, '[{"path":"/original"},{"path":"/second"}]');
    assert.equal(getNode('root-w')?.workspace_id, 'ws-w');
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
