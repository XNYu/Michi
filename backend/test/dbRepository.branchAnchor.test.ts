/**
 * Round-trip tests for the branch-provenance schema additions (migration 0005):
 *   edges.anchor_message_id  TEXT
 *   edges.created_at         INTEGER
 *   nodes.follow_ups_source_message_id TEXT
 *
 * Each test uses a fresh temp-dir DB so they are fully isolated.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb } from '../src/services/db';
import {
  saveWorkspace,
  saveNode,
  saveEdge,
  listEdges,
  getNode,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-anchor-test-'));
}

function insertWorkspace(id: string) {
  saveWorkspace({
    id, name: 'test-ws', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
  });
}

function insertNode(wsId: string, id: string) {
  saveNode({
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: null, deletion_group_id: null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, acp_session_id: null,
    runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
  });
}

// ---------------------------------------------------------------------------
// Edge round-trips
// ---------------------------------------------------------------------------

describe('saveEdge / listEdges — anchor_message_id and created_at', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('persists and reads back anchor_message_id and created_at', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'src');
    insertNode('ws1', 'tgt');

    saveEdge({
      id: 'e1',
      workspace_id: 'ws1',
      source_node_id: 'src',
      target_node_id: 'tgt',
      kind: 'branch',
      anchor_message_id: 'msg-parent-42',
      created_at: 1_700_000_000_000,
    });

    const edges = listEdges('ws1');
    assert.equal(edges.length, 1);
    const e = edges[0];
    assert.equal(e.anchor_message_id, 'msg-parent-42');
    assert.equal(e.created_at, 1_700_000_000_000);
  });

  test('null anchor_message_id and created_at round-trip correctly', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'src');
    insertNode('ws1', 'tgt');

    saveEdge({
      id: 'e2',
      workspace_id: 'ws1',
      source_node_id: 'src',
      target_node_id: 'tgt',
      kind: 'branch',
      // deliberately omit anchor_message_id / created_at → defaults to null
    });

    const edges = listEdges('ws1');
    assert.equal(edges.length, 1);
    const e = edges[0];
    assert.equal(e.anchor_message_id ?? null, null);
    assert.equal(e.created_at ?? null, null);
  });

  test('ON CONFLICT upsert updates anchor_message_id and created_at', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'src');
    insertNode('ws1', 'tgt');

    saveEdge({ id: 'e3', workspace_id: 'ws1', source_node_id: 'src',
      target_node_id: 'tgt', kind: 'branch',
      anchor_message_id: 'old-msg', created_at: 100 });
    // Upsert with new values.
    saveEdge({ id: 'e3', workspace_id: 'ws1', source_node_id: 'src',
      target_node_id: 'tgt', kind: 'branch',
      anchor_message_id: 'new-msg', created_at: 999 });

    const edges = listEdges('ws1');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].anchor_message_id, 'new-msg');
    assert.equal(edges[0].created_at, 999);
  });
});

// ---------------------------------------------------------------------------
// Node round-trip
// ---------------------------------------------------------------------------

describe('saveNode / getNode — follow_ups_source_message_id', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('persists and reads back follow_ups_source_message_id', () => {
    insertWorkspace('ws1');

    saveNode({
      id: 'n1', workspace_id: 'ws1',
      tree_id: null, parent_node_id: null,
      kind: 'chat', title: 'node1', status: 'idle',
      position_x: null, position_y: null, minimized: 0,
      deleted_at: null, deletion_group_id: null,
      spawned_by_agent: 0, current_mode_id: null, pane_width: null,
      digest: null, follow_ups: '["q1","q2"]',
      follow_ups_source_message_id: 'asst-msg-99',
      acp_session_id: null,
      runtime_id: null, provider_id: null, model_id: null,
      reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null,
      trim_snapshot: null,
      created_at: 1,
    });

    const node = getNode('n1');
    assert.ok(node, 'node should exist');
    assert.equal(node.follow_ups_source_message_id, 'asst-msg-99');
  });

  test('null follow_ups_source_message_id round-trips correctly', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'n2');

    const node = getNode('n2');
    assert.ok(node, 'node should exist');
    assert.equal(node.follow_ups_source_message_id ?? null, null);
  });

  test('ON CONFLICT upsert updates follow_ups_source_message_id', () => {
    insertWorkspace('ws1');
    insertNode('ws1', 'n3');

    // First write sets the field.
    saveNode({
      id: 'n3', workspace_id: 'ws1',
      tree_id: null, parent_node_id: null,
      kind: 'chat', title: 'n3', status: 'idle',
      position_x: null, position_y: null, minimized: 0,
      deleted_at: null, deletion_group_id: null,
      spawned_by_agent: 0, current_mode_id: null, pane_width: null,
      digest: null, follow_ups: null,
      follow_ups_source_message_id: 'msg-v1',
      acp_session_id: null,
      runtime_id: null, provider_id: null, model_id: null,
      reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null,
      trim_snapshot: null,
      created_at: 1,
    });

    // Second write updates it.
    saveNode({
      id: 'n3', workspace_id: 'ws1',
      tree_id: null, parent_node_id: null,
      kind: 'chat', title: 'n3', status: 'idle',
      position_x: null, position_y: null, minimized: 0,
      deleted_at: null, deletion_group_id: null,
      spawned_by_agent: 0, current_mode_id: null, pane_width: null,
      digest: null, follow_ups: null,
      follow_ups_source_message_id: 'msg-v2',
      acp_session_id: null,
      runtime_id: null, provider_id: null, model_id: null,
      reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null,
      trim_snapshot: null,
      created_at: 1,
    });

    const node = getNode('n3');
    assert.ok(node);
    assert.equal(node.follow_ups_source_message_id, 'msg-v2');
  });
});
