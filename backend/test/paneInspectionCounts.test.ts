import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import {
  getMessageCountsByNode,
  getCompletedTurnCount,
  saveMessage,
  saveNode,
  saveTree,
  saveWorkspace,
  type MessageRow,
} from '../src/services/dbRepository';

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

/** Seed a turns row directly — the beginTurn/checkpointTurn/finalizeTurn state
 *  machine only ever produces one terminal status per call chain, but the
 *  acceptance criteria need fixture rows in every status side by side. */
function seedTurn(input: {
  turnId: string;
  nodeId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  status: 'active' | 'completed' | 'cancelled' | 'error';
}): void {
  getDb()
    .prepare(
      `INSERT INTO turns (
        turn_id, node_id, user_message_id, assistant_message_id, status,
        last_seq, stop_reason, error, started_at, checkpoint_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, NULL, ?, ?)`,
    )
    .run(
      input.turnId,
      input.nodeId,
      input.userMessageId,
      input.assistantMessageId,
      input.status,
      Date.now(),
      input.status === 'active' ? null : Date.now(),
      Date.now(),
    );
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

  test('a self-turn (user_message_id IS NULL, completed) is counted', () => {
    seedWorkspace('ws-1');
    seedNode('node-1', 'ws-1');
    seedTurn({ turnId: 't-self', nodeId: 'node-1', userMessageId: null, assistantMessageId: 'a-self', status: 'completed' });

    const result = getCompletedTurnCount('node-1');
    assert.deepEqual(result, { count: 1, coverage: 'complete' });
  });

  test('owner scoping: with MICHI_CLOUD=1, a node owned by another user returns 0 / is not counted', () => {
    process.env.MICHI_CLOUD = '1';
    try {
      seedWorkspace('ws-owned', 'owner-a');
      seedNode('node-1', 'ws-owned');
      const userMessageId = seedMessage('node-1', 'user');
      const assistantMessageId = seedMessage('node-1', 'assistant');
      seedTurn({ turnId: 't-completed', nodeId: 'node-1', userMessageId, assistantMessageId, status: 'completed' });

      const countsAsOwner = getMessageCountsByNode('node-1', 'owner-a');
      assert.deepEqual(countsAsOwner, { total: 2, user: 1, assistant: 1 });
      const countsAsOther = getMessageCountsByNode('node-1', 'owner-b');
      assert.deepEqual(countsAsOther, { total: 0, user: 0, assistant: 0 });

      const turnsAsOwner = getCompletedTurnCount('node-1', 'owner-a');
      assert.deepEqual(turnsAsOwner, { count: 1, coverage: 'complete' });
      const turnsAsOther = getCompletedTurnCount('node-1', 'owner-b');
      // Not owned: both the completed-count and the any-turn-row check are
      // scoped out, so this resolves as "no turn rows, no assistant messages
      // visible either" -> complete/0, never a leak of the other owner's data.
      assert.deepEqual(turnsAsOther, { count: 0, coverage: 'complete' });
    } finally {
      delete process.env.MICHI_CLOUD;
    }
  });

  test('EXPLAIN QUERY PLAN for getMessageCountsByNode query', () => {
    seedWorkspace('ws-1');
    seedNode('node-1', 'ws-1');
    const plan = getDb()
      .prepare('EXPLAIN QUERY PLAN SELECT role, COUNT(*) as cnt FROM messages WHERE node_id = ? GROUP BY role')
      .all('node-1') as Array<{ detail: string }>;
    // Recorded verbatim in the task report. Assert only that a plan exists —
    // the report captures the actual `detail` strings measured against a
    // larger seeded dataset outside this fast unit test.
    assert.ok(plan.length > 0);
  });
});
