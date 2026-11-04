import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import { getWorkspace, moveTreeToWorkspace } from '../src/services/dbRepository';
import { ensureDurableGraphNode } from '../src/services/graphCommands';

const REPAIR_MIGRATION = path.join(__dirname, '../src/db/migrations/0062_repair_moved_active_tree.sql');

function workspace(id: string, activeTreeId: string | null = null): void {
  getDb().prepare('INSERT INTO workspaces(id,name,active_tree_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run(id, id, activeTreeId);
}

function tree(workspaceId: string, id: string, lastActiveAt: number, opts: { archived?: boolean; deletedRoot?: boolean } = {}): void {
  const root = `root-${id}`;
  getDb().prepare('INSERT INTO trees(id,workspace_id,root_node_id,archived_at,last_active_at,created_at) VALUES (?,?,?,?,?,1)')
    .run(id, workspaceId, root, opts.archived ? 5 : null, lastActiveAt);
  getDb().prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,status,created_at,deleted_at) VALUES (?,?,?,'chat','idle',1,?)")
    .run(root, workspaceId, id, opts.deletedRoot ? 5 : null);
}

const activeTree = (id: string) => getWorkspace(id)?.active_tree_id ?? null;

describe('moving a tree keeps the source active tree in its workspace', () => {
  let dir: string;
  let oldData: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-move-active-tree-'));
    oldData = process.env.MICHI_DATA_DIR;
    process.env.MICHI_DATA_DIR = dir;
    closeDb(); initDb();
    workspace('target');
  });
  afterEach(() => {
    closeDb();
    if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('falls back to the most recent unarchived tree with a live root', () => {
    workspace('src', 'moving');
    tree('src', 'moving', 50);
    tree('src', 'older', 10);
    tree('src', 'newer', 20);
    tree('src', 'archived', 40, { archived: true });
    tree('src', 'deleted', 30, { deletedRoot: true });
    moveTreeToWorkspace('moving', 'src', 'target');
    assert.equal(activeTree('src'), 'newer');
    assert.equal(activeTree('target'), null);
  });

  test('clears the active tree when no other tree qualifies, and leaves other choices alone', () => {
    workspace('only', 'moving');
    tree('only', 'moving', 1);
    moveTreeToWorkspace('moving', 'only', 'target');
    assert.equal(activeTree('only'), null);

    workspace('kept', 'stay');
    tree('kept', 'stay', 1);
    tree('kept', 'leave', 2);
    moveTreeToWorkspace('leave', 'kept', 'target');
    assert.equal(activeTree('kept'), 'stay');
  });

  test('a graph command in the source workspace succeeds after the move', () => {
    workspace('src', 'moving');
    tree('src', 'moving', 2);
    tree('src', 'rest', 1);
    moveTreeToWorkspace('moving', 'src', 'target');
    assert.doesNotThrow(() => ensureDurableGraphNode({
      workspace: { id: 'src', name: 'src', createdAt: 1, activeTreeId: activeTree('src') },
      tree: { id: 'fresh', rootNodeId: 'fresh-root', createdAt: 3, lastActiveAt: 3 },
      node: { id: 'fresh-root', treeId: 'fresh', kind: 'chat', createdAt: 3 },
      edges: [],
    }));
  });

  test('the repair migration repoints workspaces already left dangling', () => {
    workspace('dangling', 'moving');
    tree('dangling', 'moving', 9);
    tree('dangling', 'rest', 1);
    workspace('empty', 'gone');
    workspace('healthy', 'mine');
    tree('healthy', 'mine', 1);
    tree('healthy', 'later', 2);
    // The state an earlier move left: the tree row flipped, the pointer not.
    getDb().prepare("UPDATE trees SET workspace_id = 'target' WHERE id = 'moving'").run();
    getDb().exec(fs.readFileSync(REPAIR_MIGRATION, 'utf8'));
    assert.equal(activeTree('dangling'), 'rest');
    assert.equal(activeTree('empty'), null);
    assert.equal(activeTree('healthy'), 'mine');
  });
});
