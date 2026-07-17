/**
 * Regression test for the external_session_id sync-clobber bug.
 *
 * external_session_id is minted server-side from claude's `system/init`
 * (ClaudeSession captures session_id → setNodeExternalSessionId). The frontend
 * never knows it: serializeNodeRow() omits the column entirely, so every node
 * sync upserts it as NULL. saveNode's ON CONFLICT clause used to do a plain
 * `external_session_id=excluded.external_session_id`, which clobbered the
 * just-persisted claude UUID back to NULL on the very next sync — permanently
 * breaking native `claude --resume` (loadSession threw → silent fresh+replay).
 *
 * The fix wraps it in COALESCE(excluded..., nodes...), preserving the stored
 * value when the incoming row omits it. These tests pin that behaviour. They
 * are intentionally NOT gated behind MICHI_CLAUDE_SMOKE — no real claude binary
 * is needed; the bug lives purely in the SQLite upsert.
 *
 * Uses node:test with a fresh MICHI_DATA_DIR per test (mirrors
 * resumeBindingRepository.test.ts) so each case starts from a migrated DB.
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
  setNodeExternalSessionId,
  getNodeExternalSessionId,
} from '../src/services/dbRepository';
import type { NodeRow } from '../src/services/dbRepository';

const UUID = '183ff37a-7f39-49ee-bd9e-463d10ef9a96';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-ext-sid-test-'));
}

/**
 * A node row shaped like what the frontend's serializeNodeRow() produces:
 * it carries acp_session_id / resume_fingerprint etc. but external_session_id
 * is always NULL (the frontend cannot know the server-minted claude UUID).
 */
function syncNode(wsId: string, id: string): NodeRow {
  return {
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: null, deletion_group_id: null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, follow_ups_source_message_id: null,
    acp_session_id: id, runtime_id: 'claude',
    provider_id: null, model_id: null, reasoning: null,
    resume_fingerprint: null, composer_draft: null,
    external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
  } as NodeRow;
}

describe('external_session_id — survives frontend sync upserts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({
      id: 'ws1', name: 'test', cwd: null, active_tree_id: null,
      created_at: 1, updated_at: 1, settings: null,
      deleted_at: null, archived_at: null,
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a sync after init does NOT wipe the claude session UUID (the bug)', () => {
    // 1. node exists (created/synced by the frontend)
    saveNode(syncNode('ws1', 'n1'));
    // 2. claude system/init persists the server-minted UUID
    setNodeExternalSessionId('n1', UUID);
    assert.equal(getNodeExternalSessionId('n1'), UUID);
    // 3. frontend syncs the node again (drag, title edit, next message…) with
    //    external_session_id absent → NULL. Must NOT clobber.
    saveNode(syncNode('ws1', 'n1'));
    assert.equal(getNodeExternalSessionId('n1'), UUID);
  });

  test('repeated syncs keep preserving it', () => {
    saveNode(syncNode('ws1', 'n1'));
    setNodeExternalSessionId('n1', UUID);
    for (let i = 0; i < 5; i++) saveNode(syncNode('ws1', 'n1'));
    assert.equal(getNodeExternalSessionId('n1'), UUID);
  });

  test('an explicit non-null external_session_id still wins', () => {
    saveNode(syncNode('ws1', 'n1'));
    setNodeExternalSessionId('n1', UUID);
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    saveNode({ ...syncNode('ws1', 'n1'), external_session_id: other });
    assert.equal(getNodeExternalSessionId('n1'), other);
  });

  test('the first-ever saveNode with no UUID leaves it null (no false positive)', () => {
    saveNode(syncNode('ws1', 'n1'));
    assert.equal(getNodeExternalSessionId('n1'), null);
  });

  test('frontend sync cannot replace a persisted Kiro ACP sid with the public node id', () => {
    saveNode({
      ...syncNode('ws1', 'n1'),
      runtime_id: 'kiro',
      acp_session_id: 'acp-session-1',
    });
    saveNode({
      ...syncNode('ws1', 'n1'),
      runtime_id: 'kiro',
      acp_session_id: 'n1',
    });
    const row = getDb().prepare('SELECT acp_session_id FROM nodes WHERE id = ?')
      .get('n1') as { acp_session_id: string | null };
    assert.equal(row.acp_session_id, 'acp-session-1');
  });

  test('frontend sync cannot erase a server-persisted runtime binding', () => {
    saveNode({
      ...syncNode('ws1', 'n1'),
      runtime_id: 'kiro',
      acp_session_id: 'acp-session-1',
    });
    saveNode({
      ...syncNode('ws1', 'n1'),
      runtime_id: null,
      acp_session_id: null,
    });
    const row = getDb().prepare('SELECT acp_session_id, runtime_id FROM nodes WHERE id = ?')
      .get('n1') as { acp_session_id: string | null; runtime_id: string | null };
    assert.equal(row.acp_session_id, 'acp-session-1');
    assert.equal(row.runtime_id, 'kiro');
  });

  test('a stale frontend runtime cannot replace a server-persisted runtime binding', () => {
    saveNode({
      ...syncNode('ws1', 'n1'),
      runtime_id: 'kiro',
      acp_session_id: 'acp-session-1',
    });
    saveNode({
      ...syncNode('ws1', 'n1'),
      runtime_id: 'claude',
      acp_session_id: null,
    });
    const row = getDb().prepare('SELECT runtime_id FROM nodes WHERE id = ?')
      .get('n1') as { runtime_id: string | null };
    assert.equal(row.runtime_id, 'kiro');
  });
});
