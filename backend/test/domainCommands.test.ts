import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { getNode, getWorkspace, listContexts, listEdges, listTrees, saveWorkspace } from '../src/services/dbRepository';

describe('workspace domain commands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-domain-commands-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('applies an explicit command batch transactionally and replays it idempotently', () => {
    const input = {
      operationId: 'op-1',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' } },
        { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root', last_active_at: 1, created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null, kind: 'chat', title: null, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } },
        { type: 'context.upsert', payload: { id: 'ctx-1', workspace_id: 'ws-1', name: 'guide', file_path: '/guide.md', auto_inject: 0, source: 'user', created_at: 1, updated_at: 1 } },
      ],
    } as const;

    const first = applyWorkspaceCommands('ws-1', input);
    const replay = applyWorkspaceCommands('ws-1', input);

    assert.deepEqual(replay, first);
    assert.equal(getWorkspace('ws-1')?.name, 'Workspace');
    assert.equal(listTrees('ws-1').length, 1);
    assert.equal(getNode('root')?.tree_id, 'tree-1');
    assert.equal(listContexts('ws-1').length, 1);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM command_receipts').get() as { count: number }).count, 1);
  });

  test('rejects operation id reuse with a different payload', () => {
    applyWorkspaceCommands('ws-1', {
      operationId: 'op-reused',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'One', created_at: 1, updated_at: 1 } }],
    });
    assert.throws(() => applyWorkspaceCommands('ws-1', {
      operationId: 'op-reused',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Two', created_at: 1, updated_at: 2 } }],
    }), /different payload/i);
    assert.equal(getWorkspace('ws-1')?.name, 'One');
  });

  test('rejects cross-workspace edges and rolls back the whole batch', () => {
    applyWorkspaceCommands('ws-a', {
      operationId: 'seed-a',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-a', name: 'A', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a', workspace_id: 'ws-a', tree_id: null, parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } },
      ],
    });
    applyWorkspaceCommands('ws-b', {
      operationId: 'seed-b',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-b', name: 'B', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'b', workspace_id: 'ws-b', tree_id: null, parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } },
      ],
    });
    assert.throws(() => applyWorkspaceCommands('ws-a', {
      operationId: 'bad-edge',
      commands: [{ type: 'edge.upsert', payload: { id: 'link-a-b', workspace_id: 'ws-a', source_node_id: 'a', target_node_id: 'b', kind: 'link' } }],
    }), /same workspace/i);
    assert.equal(listEdges('ws-a').length, 0);
  });

  test('workspace commands preserve the existing runtime backend', () => {
    saveWorkspace({
      id: 'ws-1', name: 'Before', created_at: 1, updated_at: 1, backend: 'claude',
    });

    applyWorkspaceCommands('ws-1', {
      operationId: 'rename-only',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'After' } }],
    });

    assert.equal(getWorkspace('ws-1')?.name, 'After');
    assert.equal(getWorkspace('ws-1')?.backend, 'claude');
  });

  test('rejects tree, edge, and context ids that already belong to another workspace', () => {
    applyWorkspaceCommands('ws-a', {
      operationId: 'seed-collision-a',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-a', name: 'A', created_at: 1, updated_at: 1 } },
        { type: 'tree.upsert', payload: { id: 'tree-shared', workspace_id: 'ws-a', root_node_id: 'a1', name: 'A tree', last_active_at: 1, created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a1', workspace_id: 'ws-a', tree_id: 'tree-shared', parent_node_id: null, kind: 'chat', created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a2', workspace_id: 'ws-a', tree_id: 'tree-shared', parent_node_id: 'a1', kind: 'chat', created_at: 2 } },
        { type: 'edge.upsert', payload: { id: 'edge-shared', workspace_id: 'ws-a', source_node_id: 'a1', target_node_id: 'a2', kind: 'branch' } },
        { type: 'context.upsert', payload: { id: 'ctx-shared', workspace_id: 'ws-a', name: 'a-context', file_path: '/a.md' } },
      ],
    });
    applyWorkspaceCommands('ws-b', {
      operationId: 'seed-collision-b',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-b', name: 'B', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'b1', workspace_id: 'ws-b', tree_id: null, parent_node_id: null, kind: 'chat', created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'b2', workspace_id: 'ws-b', tree_id: null, parent_node_id: null, kind: 'chat', created_at: 2 } },
      ],
    });

    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'collide-tree',
      commands: [{ type: 'tree.upsert', payload: { id: 'tree-shared', workspace_id: 'ws-b', root_node_id: 'b1', name: 'B tree' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'collide-edge',
      commands: [{ type: 'edge.upsert', payload: { id: 'edge-shared', workspace_id: 'ws-b', source_node_id: 'b1', target_node_id: 'b2', kind: 'branch' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'collide-context',
      commands: [{ type: 'context.upsert', payload: { id: 'ctx-shared', workspace_id: 'ws-b', name: 'b-context', file_path: '/b.md' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'delete-foreign-tree',
      commands: [{ type: 'tree.delete', payload: { id: 'tree-shared' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'delete-foreign-edge',
      commands: [{ type: 'edge.delete', payload: { id: 'edge-shared' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'delete-foreign-context',
      commands: [{ type: 'context.delete', payload: { id: 'ctx-shared' } }],
    }), /different workspace/i);

    assert.equal(listTrees('ws-a')[0]?.name, 'A tree');
    assert.equal(listEdges('ws-a')[0]?.source_node_id, 'a1');
    assert.equal(listContexts('ws-a')[0]?.name, 'a-context');
  });

  test('rejects cross-workspace tree references, roots, and context origins', () => {
    applyWorkspaceCommands('ws-a', {
      operationId: 'seed-reference-a',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-a', name: 'A', created_at: 1, updated_at: 1 } },
        { type: 'tree.upsert', payload: { id: 'tree-a', workspace_id: 'ws-a', root_node_id: 'a-root', last_active_at: 1, created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a-root', workspace_id: 'ws-a', tree_id: 'tree-a', parent_node_id: null, kind: 'chat', created_at: 1 } },
      ],
    });
    applyWorkspaceCommands('ws-b', {
      operationId: 'seed-reference-b',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-b', name: 'B', created_at: 1, updated_at: 1 } }],
    });

    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'foreign-tree-ref',
      commands: [{ type: 'node.upsert', payload: { id: 'b-node', workspace_id: 'ws-b', tree_id: 'tree-a', parent_node_id: null, kind: 'chat', created_at: 1 } }],
    }), /tree.*same workspace|different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'foreign-tree-root',
      commands: [{ type: 'tree.upsert', payload: { id: 'tree-b', workspace_id: 'ws-b', root_node_id: 'a-root', last_active_at: 1, created_at: 1 } }],
    }), /root.*same workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'foreign-context-origin',
      commands: [{ type: 'context.upsert', payload: { id: 'ctx-b', workspace_id: 'ws-b', name: 'ctx-b', file_path: '/b.md', origin_node_id: 'a-root' } }],
    }), /origin.*same workspace/i);

    assert.equal(getNode('b-node'), null);
    assert.equal(listTrees('ws-b').length, 0);
    assert.equal(listContexts('ws-b').length, 0);
  });
});
