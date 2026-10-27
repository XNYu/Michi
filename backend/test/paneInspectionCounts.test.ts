import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initDb } from '../src/services/db';
import { getMessageCountsByNode, saveMessage, saveNode, saveTree, saveWorkspace, type MessageRow } from '../src/services/dbRepository';

function seedWorkspace(workspaceId: string, ownerUserId: string | null = null): void {
  saveWorkspace({
    id: workspaceId,
    name: 'Workspace',
    created_at: 1,
    updated_at: 1,
    active_tree_id: null,
    cwd: null,
    settings: null,
    owner_user_id: ownerUserId,
  });
}

function seedNode(nodeId: string, workspaceId: string): void {
  saveTree({
    id: `${nodeId}-tree`,
    workspace_id: workspaceId,
    root_node_id: nodeId,
    name: null,
    archived_at: null,
    pinned_at: null,
    last_active_at: 1,
    created_at: 1,
  });
  saveNode({
    id: nodeId,
    workspace_id: workspaceId,
    tree_id: `${nodeId}-tree`,
    parent_node_id: null,
    kind: 'chat',
    title: null,
    branch_overview: null,
    status: 'idle',
    position_x: null,
    position_y: null,
    minimized: 0,
    deleted_at: null,
    deletion_group_id: null,
    spawned_by_agent: 0,
    current_mode_id: null,
    pane_width: null,
    digest: null,
    follow_ups: null,
    follow_ups_source_message_id: null,
    acp_session_id: null,
    runtime_id: null,
    provider_id: null,
    model_id: null,
    reasoning: null,
    resume_fingerprint: null,
    composer_draft: null,
    external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
  });
}

let seq = 0;
function seedMessage(nodeId: string, role: string, content = 'hi'): string {
  const msg: MessageRow = {
    id: `msg-${nodeId}-${seq}`,
    node_id: nodeId,
    role,
    content,
    blocks: null,
    tool_calls: null,
    metadata: null,
    seq: seq++,
    created_at: Date.now(),
    rev: null,
  };
  saveMessage(msg);
  return msg.id;
}

describe('paneInspection message/turn count queries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-inspection-counts-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seq = 0;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MICHI_CLOUD;
  });

  test('total is a true COUNT(*), not user + assistant, for an unexpected role', () => {
    seedWorkspace('ws-1');
    seedNode('node-1', 'ws-1');
    seedMessage('node-1', 'user');
    seedMessage('node-1', 'assistant');
    seedMessage('node-1', 'system'); // no CHECK constraint on role

    const counts = getMessageCountsByNode('node-1');
    assert.deepEqual(counts, { total: 3, user: 1, assistant: 1 });
  });
});
