import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, type NodeRow } from '../src/services/dbRepository';
import { chatReplayUnavailable } from '../src/routes/chatReplay';

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

test('a completed or unknown turn asks for saved-state reconciliation without claiming a restart', () => {
    getDb().prepare("UPDATE turns SET status = 'completed', error = NULL WHERE turn_id = ?").run('turn');
    const result = chatReplayUnavailable('node', 'turn');
    assert.equal(result.code, 'turn_replay_unavailable');
    assert.match(result.error, /saved state/);
});
