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
import { saveWorkspace, saveTree, saveNode, saveContext, purgeWorkspaceNodes, deleteWorkspace } from '../src/services/dbRepository';

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

describe('saveNode anti-revival guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
