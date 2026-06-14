/**
 * Regression tests for updateNodeResumeBinding's current_mode_id handling.
 *
 * A node re-binds on every ensure-session (message submit). A freshly (re)bound
 * kiro session does NOT report its agent, so session.currentModeId is null —
 * and a plain assignment used to wipe the user's persisted agent, leaving the
 * composer stuck on the generic "agent" label after restart. The binding must
 * preserve the stored mode when handed null, and only overwrite on an explicit
 * (non-null) switch.
 *
 * Uses node:test with a fresh MICHI_DATA_DIR per test (mirrors
 * trimNodeRepository.test.ts) so each case starts from a migrated SQLite file.
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
  updateNodeResumeBinding,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-resume-bind-test-'));
}

function insertNode(wsId: string, id: string, currentModeId: string | null) {
  saveNode({
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: null, deletion_group_id: null,
    spawned_by_agent: 0, current_mode_id: currentModeId, pane_width: null,
    digest: null, follow_ups: null, acp_session_id: null,
    runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
  });
}

function modeOf(id: string): string | null {
  const row = getDb()
    .prepare('SELECT current_mode_id FROM nodes WHERE id = ?')
    .get(id) as { current_mode_id: string | null } | undefined;
  return row?.current_mode_id ?? null;
}

const BINDING = {
  acp_session_id: 'sess-1',
  runtime_id: 'kiro',
  provider_id: null,
  model_id: null,
  reasoning: null,
  resume_fingerprint: 'fp-1',
};

describe('updateNodeResumeBinding — current_mode_id preservation', () => {
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

  test('null mode preserves the persisted agent (the restart bug)', () => {
    insertNode('ws1', 'n1', 'gpu-dev');
    updateNodeResumeBinding('n1', { ...BINDING, current_mode_id: null });
    assert.equal(modeOf('n1'), 'gpu-dev');
  });

  test('a non-null mode overwrites (explicit switch still works)', () => {
    insertNode('ws1', 'n1', 'gpu-dev');
    updateNodeResumeBinding('n1', { ...BINDING, current_mode_id: 'security-reviewer' });
    assert.equal(modeOf('n1'), 'security-reviewer');
  });

  test('null mode on a node that never had one stays null', () => {
    insertNode('ws1', 'n1', null);
    updateNodeResumeBinding('n1', { ...BINDING, current_mode_id: null });
    assert.equal(modeOf('n1'), null);
  });

  test('other binding columns still assign unconditionally', () => {
    insertNode('ws1', 'n1', 'gpu-dev');
    updateNodeResumeBinding('n1', {
      acp_session_id: 'sess-2',
      runtime_id: 'kiro',
      provider_id: 'anthropic',
      model_id: 'claude-opus-4-7',
      reasoning: 'high',
      resume_fingerprint: 'fp-2',
      current_mode_id: null,
    });
    const row = getDb()
      .prepare('SELECT acp_session_id, model_id, reasoning, current_mode_id FROM nodes WHERE id = ?')
      .get('n1') as { acp_session_id: string; model_id: string; reasoning: string; current_mode_id: string };
    assert.equal(row.acp_session_id, 'sess-2');
    assert.equal(row.model_id, 'claude-opus-4-7');
    assert.equal(row.reasoning, 'high');
    assert.equal(row.current_mode_id, 'gpu-dev'); // preserved
  });
});
