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
  getNode,
  updateNodeResumeBinding,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-resume-bind-test-'));
}

function insertNode(wsId: string, id: string, currentModeId: string | null) {
  const node: Parameters<typeof saveNode>[0] = {
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
  };
  saveNode(node);
  return node;
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

  test('a delayed graph snapshot cannot overwrite the signature of a native session', () => {
    const stale = insertNode('ws1', 'n1', 'gpu-dev');
    updateNodeResumeBinding('n1', {
      ...BINDING, model_id: 'bound-model', provider_id: 'bound-provider', reasoning: 'high',
    });
    saveNode({ ...stale, title: 'updated title', model_id: 'stale-model', provider_id: null, reasoning: null });
    const row = getNode('n1')!;
    assert.equal(row.title, 'updated title');
    assert.equal(row.acp_session_id, 'sess-1');
    assert.equal(row.model_id, 'bound-model');
    assert.equal(row.provider_id, 'bound-provider');
    assert.equal(row.reasoning, 'high');
  });
});
