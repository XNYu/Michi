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
import { saveWorkspace, saveNode, listNodes, purgeWorkspaceNodes } from '../src/services/dbRepository';

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

  test('is a no-op for an empty list', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'a');

    const purged = purgeWorkspaceNodes('ws1', []);

    assert.equal(purged, 0);
    assert.equal(listNodes('ws1').length, 1);
  });
});
