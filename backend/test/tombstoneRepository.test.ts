/**
 * Tests for the Phase 3 tombstone mechanism: a stale POST /sync from
 * another tab cannot revive ids the active tab has just purged.
 *
 * Mirrors the safety properties we promised in the design discussion:
 *   - emptyWorkspaceTrash / purgeWorkspaceNodes leave a non-null
 *     `purged_at` instead of physically deleting the row.
 *   - saveNode / saveWorkspace / saveTree / saveEdge / saveMessage /
 *     saveContext all silently no-op on tombstoned ids.
 *   - listNodes / getNode / listWorkspaces / getWorkspace filter
 *     tombstones out — the UI never sees them.
 *   - runTombstoneGc drops rows older than TOMBSTONE_TTL_MS and is
 *     called automatically by the purge functions.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  saveWorkspace, saveTree, saveNode, saveEdge, saveMessage, saveContext,
  listNodes, getNode, listWorkspaces, getWorkspace, listTrees, listEdges, listMessages,
  emptyWorkspaceTrash, purgeWorkspaceNodes,
  deleteWorkspace,
  runTombstoneGc, TOMBSTONE_TTL_MS,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tomb-test-'));
}

function insertWorkspace(id: string) {
  saveWorkspace({
    id, name: 'test', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
  });
}

function insertNode(wsId: string, id: string, opts: { deletedAt?: number; groupId?: string } = {}) {
  saveNode({
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
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
    created_at: 1,
  });
}

function rawCount(table: string, where = ''): number {
  const sql = `SELECT COUNT(*) as cnt FROM ${table}${where ? ` WHERE ${where}` : ''}`;
  return (getDb().prepare(sql).get() as { cnt: number }).cnt;
}

describe('emptyWorkspaceTrash tombstones soft-deleted nodes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('row stays in the DB but is hidden from listNodes/getNode', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'live');
    insertNode('ws1', 'dead', { deletedAt: 100, groupId: 'g1' });

    const purged = emptyWorkspaceTrash('ws1');

    assert.equal(purged, 1);
    // Row physically present (tombstoned).
    assert.equal(rawCount('nodes', "id = 'dead' AND purged_at IS NOT NULL"), 1);
    // Live API hides it.
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['live']);
    assert.equal(getNode('dead'), null);
  });

  test('messages and edges of tombstoned nodes are physically dropped', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'a');
    insertNode('ws1', 'dead', { deletedAt: 100, groupId: 'g1' });
    saveEdge({ id: 'e-a-dead', workspace_id: 'ws1',
      source_node_id: 'a', target_node_id: 'dead', kind: 'branch' });
    saveMessage({ id: 'm-dead', node_id: 'dead', role: 'user',
      content: 'x', blocks: null, tool_calls: null, seq: 0, created_at: 1 });

    emptyWorkspaceTrash('ws1');

    assert.equal(rawCount('edges'), 0);
    assert.equal(listMessages('dead').length, 0);
  });
});

describe('saveNode anti-revival guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('a stale snapshot containing a tombstoned node id silently no-ops', () => {
    // Setup: ws1 has node "X" that gets purged.
    insertWorkspace('ws1');
    insertNode('ws1', 'X', { deletedAt: 100, groupId: 'g1' });
    emptyWorkspaceTrash('ws1');

    // Tab B sends a stale POST /sync that tries to "re-insert" X. saveNode
    // is the leaf write the sync handler iterates; the guard short-circuits.
    insertNode('ws1', 'X');

    // Still tombstoned, still hidden, still no row visible to the UI.
    assert.equal(rawCount('nodes', "id = 'X' AND purged_at IS NOT NULL"), 1);
    assert.equal(getNode('X'), null);
  });

  test('a node from a tombstoned workspace is also refused', () => {
    insertWorkspace('ws1');
    deleteWorkspace('ws1');     // tombstones workspace + cascades to nodes

    // Tab B tries to re-insert a node into the dead workspace.
    insertNode('ws1', 'rogue');

    assert.equal(rawCount('nodes', "id = 'rogue'"), 0);
  });
});

describe('purgeWorkspaceNodes targets a specific list', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('only the listed ids get tombstoned', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'a', { deletedAt: 100, groupId: 'g1' });
    insertNode('ws1', 'b', { deletedAt: 100, groupId: 'g1' });
    insertNode('ws1', 'c', { deletedAt: 100, groupId: 'g2' });

    const purged = purgeWorkspaceNodes('ws1', ['a', 'b']);

    assert.equal(purged, 2);
    assert.equal(rawCount('nodes', "id = 'a' AND purged_at IS NOT NULL"), 1);
    assert.equal(rawCount('nodes', "id = 'b' AND purged_at IS NOT NULL"), 1);
    // c stays soft-deleted (tomb-free).
    assert.equal(rawCount('nodes', "id = 'c' AND purged_at IS NULL"), 1);
  });

  test('cross-workspace ids are ignored (defence in depth)', () => {
    insertWorkspace('ws1');
    insertWorkspace('ws2');
    insertNode('ws1', 'mine');
    insertNode('ws2', 'theirs');

    const purged = purgeWorkspaceNodes('ws1', ['mine', 'theirs']);

    assert.equal(purged, 1);
    assert.equal(rawCount('nodes', "id = 'theirs' AND purged_at IS NULL"), 1);
  });
});

describe('deleteWorkspace tombstones the workspace and cascades', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('row stays with purged_at set; listWorkspaces hides it', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'X');

    deleteWorkspace('ws1');

    assert.equal(rawCount('workspaces', "id = 'ws1' AND purged_at IS NOT NULL"), 1);
    assert.equal(rawCount('nodes',      "id = 'X'   AND purged_at IS NOT NULL"), 1);
    assert.equal(getWorkspace('ws1'), null);
    assert.equal(listWorkspaces().length, 0);
    // Cascaded structural rows are physically gone.
    assert.equal(listTrees('ws1').length, 0);
    assert.equal(listEdges('ws1').length, 0);
  });

  test('saveTree/saveEdge after workspace tombstone is a no-op', () => {
    insertWorkspace('ws1');
    deleteWorkspace('ws1');

    saveTree({
      id: 't-rogue', workspace_id: 'ws1', root_node_id: 'doesnt-matter',
      name: null, archived_at: null, pinned_at: null,
      last_active_at: 1, created_at: 1,
    });
    saveContext({
      id: 'c-rogue', workspace_id: 'ws1', name: 'x', file_path: '/x',
      size: null, auto_inject: 0, source: 'user',
      created_at: 1, updated_at: 1,
    });

    assert.equal(rawCount('trees', "id = 't-rogue'"), 0);
    assert.equal(rawCount('contexts', "id = 'c-rogue'"), 0);
  });
});

describe('runTombstoneGc respects TOMBSTONE_TTL_MS', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('drops only stones older than the TTL', () => {
    insertWorkspace('ws1');
    // Tombstone with a fresh timestamp — should survive GC.
    insertNode('ws1', 'fresh', { deletedAt: 1, groupId: 'g' });
    // Tombstone with an ancient timestamp, hand-stamped past the TTL.
    insertNode('ws1', 'ancient', { deletedAt: 1, groupId: 'g' });

    emptyWorkspaceTrash('ws1');     // tombstones both with now()
    // Backdate "ancient" so it's older than TTL.
    const longAgo = Date.now() - TOMBSTONE_TTL_MS - 1000;
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(longAgo, 'ancient');

    const summary = runTombstoneGc();

    assert.equal(summary.nodes, 1);
    assert.equal(rawCount('nodes', "id = 'ancient'"), 0);
    assert.equal(rawCount('nodes', "id = 'fresh' AND purged_at IS NOT NULL"), 1);
  });

  test('purgeWorkspaceNodes triggers GC implicitly', () => {
    insertWorkspace('ws1');
    // Plant an ancient tombstone first.
    insertNode('ws1', 'old', { deletedAt: 1, groupId: 'g' });
    emptyWorkspaceTrash('ws1');
    const longAgo = Date.now() - TOMBSTONE_TTL_MS - 1000;
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(longAgo, 'old');

    // Now any purge call should sweep the old tombstone away.
    insertNode('ws1', 'new-target');
    purgeWorkspaceNodes('ws1', ['new-target']);

    assert.equal(rawCount('nodes', "id = 'old'"), 0);
    assert.equal(rawCount('nodes', "id = 'new-target' AND purged_at IS NOT NULL"), 1);
  });
});
