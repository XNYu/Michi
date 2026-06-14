/**
 * Round-trip tests for the leaf-save `rev` stamp (sync L2.1, migration 0006).
 *
 * Leaf save* gained an optional `rev` on the INSERT column list + VALUES and an
 *   ON CONFLICT(id) DO UPDATE SET rev = COALESCE(excluded.rev, <table>.rev)
 * clause, with `rev: null` as the default in the .run() defaults object. So:
 *   - a caller passing a number stamps it,
 *   - a caller that omits rev inserts NULL on a NEW row,
 *   - a caller that omits rev on an EXISTING row PRESERVES the stored rev
 *     (COALESCE(null, existing) = existing).
 *
 * No guard/version-compare is added here — leaf save* stays unguarded. We only
 * assert the stamp-or-preserve behavior for saveNode and saveMessage.
 *
 * Each test uses a fresh temp-dir DB so they are fully isolated.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  saveWorkspace,
  saveNode,
  saveMessage,
  getNode,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-saverev-test-'));
}

function insertWorkspace(id: string) {
  saveWorkspace({
    id, name: 'test-ws', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
  });
}

/** Build a NodeRow with the given id and optional rev. */
function nodeRow(id: string, rev?: number) {
  return {
    id, workspace_id: 'ws1',
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: null, deletion_group_id: null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, follow_ups_source_message_id: null,
    acp_session_id: null, runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
    ...(rev === undefined ? {} : { rev }),
  };
}

/** Build a MessageRow with the given id and optional rev. */
function messageRow(id: string, seq: number, rev?: number) {
  return {
    id, node_id: 'n1', role: 'user', content: 'hi',
    blocks: null, tool_calls: null, seq, created_at: 1,
    ...(rev === undefined ? {} : { rev }),
  };
}

function readNodeRev(id: string): number | null {
  const row = getDb().prepare('SELECT rev FROM nodes WHERE id = ?').get(id) as
    | { rev: number | null }
    | undefined;
  return row ? row.rev : null;
}

function readMessageRev(id: string): number | null {
  const row = getDb().prepare('SELECT rev FROM messages WHERE id = ?').get(id) as
    | { rev: number | null }
    | undefined;
  return row ? row.rev : null;
}

describe('saveNode — rev stamp / preserve', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    insertWorkspace('ws1');
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('new node without rev inserts NULL', () => {
    saveNode(nodeRow('n-null'));
    assert.equal(readNodeRev('n-null'), null);
    const node = getNode('n-null');
    assert.ok(node, 'node should exist');
    assert.equal(node.rev ?? null, null);
  });

  test('rev=5 → preserve on no-rev upsert → rev=9 stamps', () => {
    // 1. Stamp rev = 5.
    saveNode(nodeRow('n1', 5));
    assert.equal(readNodeRev('n1'), 5, 'rev should be stamped to 5');

    // 2. Upsert same id with no rev (defaults to null) → COALESCE preserves 5.
    saveNode(nodeRow('n1'));
    assert.equal(readNodeRev('n1'), 5, 'rev should STILL be 5 after a no-rev upsert (COALESCE preserve)');

    // 3. Upsert same id with rev = 9 → stamps 9.
    saveNode(nodeRow('n1', 9));
    assert.equal(readNodeRev('n1'), 9, 'rev should be re-stamped to 9');
  });
});

describe('saveMessage — rev stamp / preserve', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    insertWorkspace('ws1');
    saveNode(nodeRow('n1'));
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('new message without rev inserts NULL', () => {
    saveMessage(messageRow('m-null', 0));
    assert.equal(readMessageRev('m-null'), null);
  });

  test('rev=5 → preserve on no-rev upsert → rev=9 stamps', () => {
    saveMessage(messageRow('m1', 0, 5));
    assert.equal(readMessageRev('m1'), 5, 'rev should be stamped to 5');

    saveMessage(messageRow('m1', 0));
    assert.equal(readMessageRev('m1'), 5, 'rev should STILL be 5 after a no-rev upsert (COALESCE preserve)');

    saveMessage(messageRow('m1', 0, 9));
    assert.equal(readMessageRev('m1'), 9, 'rev should be re-stamped to 9');
  });
});
