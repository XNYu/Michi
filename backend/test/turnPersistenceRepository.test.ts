import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  beginTurn,
  checkpointTurn,
  finalizeTurn,
  recoverInterruptedTurns,
  listMessages,
  saveNode,
  saveTree,
  saveWorkspace,
} from '../src/services/dbRepository';

function event(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

function seedNode(): void {
  saveWorkspace({
    id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1,
    active_tree_id: 'tree-1', cwd: null, settings: null,
  });
  saveTree({
    id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'node-1',
    name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1,
  });
  saveNode({
    id: 'node-1', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null,
    kind: 'chat', title: null, branch_overview: null, status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null,
    follow_ups_source_message_id: null, acp_session_id: null, runtime_id: null,
    provider_id: null, model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
  });
}

describe('turn persistence repository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-turn-persistence-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    seedNode();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('begin/checkpoint/finalize stores one canonical turn idempotently', () => {
    let snapshot = createDurableTurn({
      turnId: 'turn-1',
      assistantId: 'a-node-1-turn-1',
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      displayUserText: 'visible user text',
      userMetadata: {
        quotedText: 'quote',
        attachments: [{ name: 'a.txt', absPath: '/tmp/a.txt' }],
        comments: [{ quotedText: 'old', body: 'new' }],
      },
      startedAt: 100,
    });

    beginTurn(snapshot);
    beginTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, event('thought', { text: 'think', seq: 1 }));
    snapshot = applyTurnEvent(snapshot, event('tool_call', {
      toolCallId: 'tool-1', title: 'Read', status: 'running', seq: 2,
    }));
    snapshot = applyTurnEvent(snapshot, event('chunk', { text: 'answer', seq: 3 }));
    snapshot = applyTurnEvent(snapshot, event('plan', {
      entries: [{ content: 'persist', priority: 'high', status: 'completed' }], seq: 4,
    }));
    checkpointTurn(snapshot);
    checkpointTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, event('tool_call_update', {
      toolCallId: 'tool-1', title: '', status: 'completed', output: 'ok', seq: 5,
    }));
    snapshot = applyTurnEvent(snapshot, event('title', { title: 'Durable title', seq: 6 }));
    snapshot = applyTurnEvent(snapshot, event('follow_ups', { followUps: ['Next?'], seq: 7 }));
    snapshot = applyTurnEvent(snapshot, event('branch_overview', { overview: 'Persisted overview.', seq: 8 }));
    snapshot = applyTurnEvent(snapshot, event('done', {
      stopReason: 'end_turn', persisted: true, completedAt: 200, seq: 9,
    }));
    finalizeTurn(snapshot);
    finalizeTurn(snapshot);

    const messages = listMessages('node-1');
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.id, 'u-a-node-1-turn-1');
    assert.equal(messages[0]?.content, 'visible user text');
    assert.deepEqual(JSON.parse(messages[0]?.metadata ?? '{}'), {
      quotedText: 'quote',
      attachments: [{ name: 'a.txt', absPath: '/tmp/a.txt' }],
      comments: [{ quotedText: 'old', body: 'new' }],
    });
    assert.equal(messages[1]?.id, 'a-node-1-turn-1');
    assert.equal(messages[1]?.content, 'answer');
    assert.deepEqual(JSON.parse(messages[1]?.tool_calls ?? '[]'), snapshot.assistantMessage.toolCalls);
    assert.deepEqual(JSON.parse(messages[1]?.blocks ?? '[]'), snapshot.assistantMessage.blocks);
    assert.deepEqual(JSON.parse(messages[1]?.metadata ?? '{}'), { plan: snapshot.assistantMessage.plan });

    const turn = getDb().prepare('SELECT * FROM turns WHERE turn_id = ?').get('turn-1') as Record<string, unknown>;
    assert.equal(turn.status, 'completed');
    assert.equal(turn.last_seq, 9);
    assert.equal(turn.completed_at, 200);

    const node = getDb().prepare(
      'SELECT title, branch_overview, follow_ups, status, last_applied_turn_id, last_applied_seq, resume_fingerprint FROM nodes WHERE id = ?',
    ).get('node-1') as Record<string, unknown>;
    assert.equal(node.title, 'Durable title');
    // branch_overview is an append-only journal: a JSON entry array.
    const overviewEntries = JSON.parse(String(node.branch_overview)) as Array<{ text: string }>;
    assert.equal(overviewEntries.length, 1);
    assert.equal(overviewEntries[0]?.text, 'Persisted overview.');
    assert.deepEqual(JSON.parse(String(node.follow_ups)), ['Next?']);
    assert.equal(node.status, 'idle');
    assert.equal(node.last_applied_turn_id, 'turn-1');
    assert.equal(node.last_applied_seq, 9);
    assert.equal(typeof node.resume_fingerprint, 'string');
    assert.ok(String(node.resume_fingerprint).length > 0);

    const fts = getDb().prepare("SELECT content FROM messages_fts WHERE messages_fts MATCH 'answer'").all();
    assert.equal(fts.length, 1);
  });

  test('beginTurn atomically consumes an agent spawn prompt outbox', () => {
    getDb().prepare('UPDATE nodes SET composer_draft = ? WHERE id = ?').run(
      JSON.stringify({ __michiPendingSpawnPrompt: 'Investigate the child' }),
      'node-1',
    );
    const snapshot = createDurableTurn({
      turnId: 'turn-spawn',
      assistantId: 'a-node-1-turn-spawn',
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      displayUserText: 'Investigate the child',
      startedAt: 250,
    });

    beginTurn(snapshot);

    const node = getDb().prepare('SELECT composer_draft FROM nodes WHERE id = ?')
      .get('node-1') as { composer_draft: string | null };
    assert.equal(node.composer_draft, null);
  });

  test('finalizes cancelled and errored partial turns without losing content', () => {
    let cancelled = createDurableTurn({
      turnId: 'turn-cancel', assistantId: 'a-cancel', nodeId: 'node-1', workspaceId: 'ws-1',
      displayUserText: 'cancel', startedAt: 300,
    });
    beginTurn(cancelled);
    cancelled = applyTurnEvent(cancelled, event('chunk', { text: 'partial cancel', seq: 1 }));
    cancelled = applyTurnEvent(cancelled, event('done', {
      stopReason: 'cancelled', completedAt: 350, seq: 2,
    }));
    finalizeTurn(cancelled);

    let failed = createDurableTurn({
      turnId: 'turn-error', assistantId: 'a-error', nodeId: 'node-1', workspaceId: 'ws-1',
      displayUserText: '', selfInitiated: true, startedAt: 400,
    });
    beginTurn(failed);
    failed = applyTurnEvent(failed, event('chunk', { text: 'partial error', seq: 1 }));
    failed = applyTurnEvent(failed, event('error', {
      message: 'runtime failed', completedAt: 450, seq: 2,
    }));
    finalizeTurn(failed);

    const rows = getDb().prepare(
      'SELECT turn_id, status FROM turns WHERE turn_id IN (?, ?) ORDER BY turn_id',
    ).all('turn-cancel', 'turn-error') as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => ({ turn_id: row.turn_id, status: row.status })), [
      { turn_id: 'turn-cancel', status: 'cancelled' },
      { turn_id: 'turn-error', status: 'error' },
    ]);
    const messages = listMessages('node-1');
    assert.equal(messages.some((message) => message.id === 'a-cancel' && message.content === 'partial cancel'), true);
    assert.equal(messages.some((message) => message.id === 'a-error' && message.content === 'partial error'), true);
    assert.equal(messages.some((message) => message.id === 'u-a-error'), false);
  });

  test('missing nodes fail before any turn or message row is written', () => {
    const snapshot = createDurableTurn({
      turnId: 'turn-missing', assistantId: 'a-missing', nodeId: 'missing', workspaceId: 'ws-1',
      displayUserText: 'hello', startedAt: 1,
    });
    assert.throws(() => beginTurn(snapshot), /node .* does not exist/i);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM turns').get() as { count: number }).count, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 0);
  });

  test('recovers an active checkpoint after backend restart without dropping partial content', () => {
    let snapshot = createDurableTurn({
      turnId: 'turn-interrupted', assistantId: 'a-interrupted', nodeId: 'node-1', workspaceId: 'ws-1',
      displayUserText: 'hello', startedAt: 500,
    });
    beginTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, event('chunk', { text: 'checkpointed partial', seq: 1 }));
    assert.equal(snapshot.assistantMessage.content, '', 'active turns defer derived content');
    checkpointTurn(snapshot);

    assert.equal(recoverInterruptedTurns(600), 1);
    assert.equal(recoverInterruptedTurns(700), 0);
    const turn = getDb().prepare('SELECT status, error, completed_at FROM turns WHERE turn_id = ?')
      .get('turn-interrupted') as Record<string, unknown>;
    assert.deepEqual({ status: turn.status, error: turn.error, completed_at: turn.completed_at }, {
      status: 'error', error: 'backend_restarted', completed_at: 600,
    });
    assert.equal(listMessages('node-1').find((message) => message.id === 'a-interrupted')?.content, 'checkpointed partial');
    assert.equal(getDb().prepare('SELECT status FROM nodes WHERE id = ?').get('node-1')?.status, 'error');
  });
});
