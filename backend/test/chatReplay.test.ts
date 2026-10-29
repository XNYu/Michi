import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, type NodeRow } from '../src/services/dbRepository';
import { chatReplayUnavailable, persistedChatReplay } from '../src/routes/chatReplay';

let dir: string;
const previousDataDir = process.env.MICHI_DATA_DIR;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-replay-error-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'workspace', name: 'Test', created_at: 1, updated_at: 1 });
    const node: NodeRow = {
        id: 'node', workspace_id: 'workspace', tree_id: null, parent_node_id: null,
        kind: 'chat', title: null, status: 'error', position_x: null, position_y: null,
        minimized: 0, deleted_at: null, deletion_group_id: null, spawned_by_agent: 0,
        current_mode_id: null, pane_width: null, digest: null, follow_ups: null,
        acp_session_id: null, runtime_id: 'crew', provider_id: null, model_id: null,
        reasoning: null, resume_fingerprint: null, composer_draft: null,
        external_session_id: null, created_at: 1,
    };
    saveNode(node);
    getDb().prepare(`INSERT INTO turns
        (turn_id, node_id, assistant_message_id, status, last_seq, error, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('turn', 'node', 'assistant', 'error', -1, 'backend_restarted', 1, 2);
});
afterEach(() => {
    closeDb();
    if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
});

test('an interrupted durable turn reports the restart instead of generic replay failure', () => {
    assert.deepEqual(chatReplayUnavailable('node', 'turn'), {
        error: 'Michi restarted while this task was running. Check the conversation before retrying.',
        code: 'backend_restarted',
    });
});

test('replay recovery never reads another node\'s turn or exposes its error', () => {
    assert.equal(chatReplayUnavailable('other-node', 'turn').code, 'turn_replay_unavailable');
    assert.equal(chatReplayUnavailable('node', 'other-turn').code, 'turn_replay_unavailable');
});

test('replay preserves an existing runtime failure without enabling blind retry', () => {
    getDb().prepare('UPDATE turns SET error = ? WHERE turn_id = ?')
        .run('ACP process exited mid-prompt', 'turn');
    assert.deepEqual(chatReplayUnavailable('node', 'turn'), {
        error: 'ACP process exited mid-prompt', code: 'turn_replay_unavailable',
    });
    assert.equal(chatReplayUnavailable('other-node', 'turn').code, 'turn_replay_unavailable');
    assert.ok(!chatReplayUnavailable('other-node', 'turn').error.includes('ACP'));
});

test('completed turns and missing errors keep the generic replay explanation', () => {
    for (const [status, error] of [['completed', 'old error'], ['error', null]]) {
        getDb().prepare('UPDATE turns SET status = ?, error = ? WHERE turn_id = ?').run(status, error, 'turn');
        assert.match(chatReplayUnavailable('node', 'turn').error, /live reply is no longer available/);
    }
});

function savedReply() {
    getDb().prepare(`UPDATE turns SET status = 'completed', error = NULL, last_seq = 2,
        stop_reason = 'end_turn', completed_at = 123 WHERE turn_id = 'turn'`).run();
    const insert = getDb().prepare(`INSERT INTO harness_events
        (node_id, turn_id, seq, event, payload, created_at) VALUES ('node', 'turn', ?, ?, ?, 1)`);
    for (const [seq, event, data] of [
        [0, 'turn_start', { userText: 'hello' }], [1, 'chunk', { text: 'Saved answer' }],
    ] as const) insert.run(seq, event, JSON.stringify({ ...data, seq, nodeId: 'node', turnId: 'turn', assistantId: 'assistant' }));
}

test('saved completion recovers full output or only the missing terminal without a live runtime', () => {
    savedReply();
    const all = persistedChatReplay('node', 'turn', 0)!;
    assert.deepEqual(all.map(event => event.event), ['turn_start', 'chunk', 'done']);
    assert.deepEqual(persistedChatReplay('node', 'turn', 2), [all[2]]);
    assert.ok(all[2].event === 'done');
    assert.equal(all[2].data.persisted, true);
    assert.equal(all[2].data.completedAt, 123);
    assert.equal(persistedChatReplay('other-node', 'turn', 0), null);
    assert.equal(persistedChatReplay('node', 'other-turn', 0), null);
    for (const cursor of [-1, 0.5, 3, NaN]) assert.equal(persistedChatReplay('node', 'turn', cursor), null);
});

test('partial output never upgrades active or failed turns to success; cancellation stays cancelled', () => {
    savedReply();
    for (const status of ['active', 'error']) {
        getDb().prepare('UPDATE turns SET status = ?').run(status);
        assert.equal(persistedChatReplay('node', 'turn', 0), null);
    }
    getDb().prepare("UPDATE turns SET status = 'cancelled'").run();
    assert.equal(persistedChatReplay('node', 'turn', 2)?.find(event => event.event === 'done')?.data.stopReason, 'cancelled');
});

test('missing or corrupt events and foreign envelopes cannot produce an incomplete successful replay', () => {
    savedReply();
    for (const payload of ['{', JSON.stringify({ seq: 1, nodeId: 'other', turnId: 'turn', assistantId: 'assistant', text: 'foreign' })]) {
        getDb().prepare('UPDATE harness_events SET payload = ? WHERE seq = 1').run(payload);
        assert.equal(persistedChatReplay('node', 'turn', 0), null);
    }
    getDb().prepare('DELETE FROM harness_events WHERE seq = 1').run();
    assert.equal(persistedChatReplay('node', 'turn', 0), null);
    // Already received content need not be replayed again.
    assert.equal(persistedChatReplay('node', 'turn', 2)?.[0].event, 'done');
    getDb().prepare(`UPDATE harness_events SET payload = ? WHERE seq = 0`).run(JSON.stringify({
        seq: 0, nodeId: 'node', turnId: 'turn', assistantId: 'assistant', selfInitiated: true,
    }));
    assert.equal(persistedChatReplay('node', 'turn', 2), null);
});
