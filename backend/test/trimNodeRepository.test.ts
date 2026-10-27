/**
 * Tests for the repository-level single-node trim/restore functions used by
 * the Phase 2 "prune a node out of the conversation" feature. The route
 * handlers are thin wrappers — verifying the SQL semantics here is enough
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

import { initDb, closeDb, getDb } from '../src/services/db';
import { saveWorkspace, saveTree, saveNode, saveEdge, listTrees, trimNode, restoreTrimmedNode } from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-trim-test-'));
}

interface NodeOpts {
  deletedAt?: number;
  groupId?: string;
  parent?: string;
  tree?: string;
  createdAt?: number;
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
    trim_snapshot: null,
    created_at: opts.createdAt ?? 1,
  });
}

function insertTree(wsId: string, id: string, rootNodeId: string) {
  saveTree({
    id, workspace_id: wsId, root_node_id: rootNodeId,
    name: null, archived_at: null, pinned_at: null,
    last_active_at: 1, created_at: 1,
  });
}

function insertBranchEdge(wsId: string, source: string, target: string) {
  saveEdge({
    id: `branch-${source}-${target}`, workspace_id: wsId,
    source_node_id: source, target_node_id: target, kind: 'branch',
  });
}

function getNode(id: string) {
  return getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
    | { id: string; parent_node_id: string | null; deleted_at: number | null;
        deletion_group_id: string | null; trim_snapshot: string | null }
    | undefined;
}

function parentOf(id: string): string | null {
  return getNode(id)?.parent_node_id ?? null;
}

describe('trimNode — tree root with children (Option A: siblings become children of new root)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    insertWorkspace('ws1');
    insertTree('ws1', 't1', 'R');
    insertNode('ws1', 'R', { tree: 't1', createdAt: 1 });
    insertNode('ws1', 'A', { tree: 't1', parent: 'R', createdAt: 2 });   // oldest
    insertNode('ws1', 'B', { tree: 't1', parent: 'R', createdAt: 3 });
    insertNode('ws1', 'C', { tree: 't1', parent: 'R', createdAt: 4 });
    insertBranchEdge('ws1', 'R', 'A');
    insertBranchEdge('ws1', 'R', 'B');
    insertBranchEdge('ws1', 'R', 'C');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('restore re-promotes R: A loses root status, B and C come back under R', () => {
    trimNode('ws1', 'R', 100, 'g1');
    restoreTrimmedNode('ws1', 'R');

    assert.equal(parentOf('R'), null);
    assert.equal(parentOf('A'), 'R');
    assert.equal(parentOf('B'), 'A',
      'B was reparented under A at trim time; restore only re-steals direct children of the resolved target parent');
    assert.equal(parentOf('C'), 'A',
      'same: C is no longer a direct child of A → R (R is the resolved target). C stays under A.');

    const trees = listTrees('ws1');
    assert.equal(trees.length, 1);
    assert.equal(trees[0].root_node_id, 'R');
  });
});

describe('trimNode — tree root with NO live children drops the tree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    insertWorkspace('ws1');
    insertTree('ws1', 't1', 'R');
    insertNode('ws1', 'R', { tree: 't1', createdAt: 1 });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('restore re-creates the tree row with R as root', () => {
    trimNode('ws1', 'R', 100, 'g1');
    restoreTrimmedNode('ws1', 'R');

    const trees = listTrees('ws1');
    assert.equal(trees.length, 1);
    assert.equal(trees[0].id, 't1');
    assert.equal(trees[0].root_node_id, 'R');
    assert.equal(parentOf('R'), null);
  });
});

describe('trimNode — walk-up restore when the original parent is also trimmed', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    insertWorkspace('ws1');
    insertTree('ws1', 't1', 'G');
    insertNode('ws1', 'G', { tree: 't1', createdAt: 1 });
    insertNode('ws1', 'P', { tree: 't1', parent: 'G', createdAt: 2 });
    insertNode('ws1', 'X', { tree: 't1', parent: 'P', createdAt: 3 });
    insertNode('ws1', 'C', { tree: 't1', parent: 'X', createdAt: 4 });
    insertBranchEdge('ws1', 'G', 'P');
    insertBranchEdge('ws1', 'P', 'X');
    insertBranchEdge('ws1', 'X', 'C');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('trim X, then trim P: restoring X resolves parent up to G', () => {
    trimNode('ws1', 'X', 100, 'gX');   // X.children=[C], C.parent=P
    trimNode('ws1', 'P', 101, 'gP');   // P.children=[C] (X is trashed but still snapshotted), C.parent=G

    // C should now be parented to G (P's parent)
    assert.equal(parentOf('C'), 'G');

    restoreTrimmedNode('ws1', 'X');

    // X.snapshot.parentId = P; P is trashed → walk up → G is live → X.parent = G
    assert.equal(parentOf('X'), 'G');
    // C is live, and C.parent was G (target parent) → C is re-stolen back under X
    assert.equal(parentOf('C'), 'X');
  });
});

describe('trimNode — guards', () => {
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

  test('cross-workspace id is rejected', () => {
    insertWorkspace('ws1');
    insertWorkspace('ws2');
    insertNode('ws2', 'X');
    const result = trimNode('ws1', 'X', 100, 'g1');
    assert.equal(result.trimmed, 0);
  });
});
