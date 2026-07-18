import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, type NodeRow, type WorkspaceRow } from '../src/services/dbRepository';
import { canAccessRuntimeChat, isRuntimeChatBoundToNode } from '../src/routes/michi';
import { requireChatOwner } from '../src/routes/middleware/ownership';

describe('foreground replay ownership', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-stream-owner-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    closeDb();
    initDb();
    const workspace: WorkspaceRow = {
      id: 'workspace-owner', name: 'Owner workspace', cwd: null, active_tree_id: null,
      created_at: 1, updated_at: 1, settings: null, deleted_at: null, archived_at: null,
    };
    saveWorkspace(workspace);
    getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?')
      .run('user-owner', workspace.id);
    const node: NodeRow = {
      id: 'node-owner', workspace_id: workspace.id, tree_id: null, parent_node_id: null,
      kind: 'chat', title: null, status: 'idle', position_x: null, position_y: null,
      minimized: 0, deleted_at: null, deletion_group_id: null, spawned_by_agent: 0,
      current_mode_id: null, pane_width: null, digest: null, follow_ups: null,
      acp_session_id: null, runtime_id: 'claude', provider_id: null, model_id: null,
      reasoning: null, resume_fingerprint: null, composer_draft: null,
      external_session_id: 'runtime-secret-chat', created_at: 1,
    };
    saveNode(node);
    saveNode({ ...node, id: 'node-other', external_session_id: null });
    saveNode({
      ...node,
      id: 'node-spawned',
      spawned_by_agent: 1,
      runtime_id: 'kiro',
      acp_session_id: 'runtime-spawned-child',
      external_session_id: null,
    });
  });

  afterEach(() => {
    closeDb();
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts the persisted runtime id only for the owning cloud user', () => {
    assert.equal(canAccessRuntimeChat('runtime-secret-chat', 'user-owner'), true);
    assert.equal(canAccessRuntimeChat('runtime-secret-chat', 'user-attacker'), false);
    assert.equal(canAccessRuntimeChat('runtime-secret-chat'), false);
  });

  it('binds a runtime chat to its single persisted node before accepting a message', () => {
    assert.equal(isRuntimeChatBoundToNode('runtime-secret-chat', 'node-owner', 'user-owner'), true);
    assert.equal(isRuntimeChatBoundToNode('runtime-secret-chat', 'node-other', 'user-owner'), false);
    assert.equal(isRuntimeChatBoundToNode('runtime-secret-chat', 'node-owner', 'user-attacker'), false);
  });

  it('accepts a newly spawned Kiro runtime id through its persisted child binding', () => {
    assert.equal(canAccessRuntimeChat('runtime-spawned-child', 'user-owner'), true);
    assert.equal(canAccessRuntimeChat('runtime-spawned-child', 'user-attacker'), false);
    assert.equal(isRuntimeChatBoundToNode('runtime-spawned-child', 'node-spawned', 'user-owner'), true);
  });

  it('does not let requireChatOwner pass unknown runtime ids in cloud mode', () => {
    let nextCalled = false;
    let statusCode: number | undefined;
    let body: unknown;
    const req = { params: { chatId: 'unknown-runtime' }, user: { id: 'user-owner' } };
    const res = {
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;

    requireChatOwner(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(statusCode, 404);
    assert.deepEqual(body, { error: 'not_found' });
  });
});
