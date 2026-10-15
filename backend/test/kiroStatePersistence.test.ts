import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../src/agents/types';
import { registerSession, clearAllSessions, dropSession } from '../src/agents/sessionRegistry';
import { subscribeSessionStates } from '../src/agents/sessionStateFeed';
import { persistSessionState } from '../src/services/sessionStatePersistence';
import { closeDb, initDb } from '../src/services/db';
import { saveWorkspace, saveNode, getNode, updateNodeResumeBinding } from '../src/services/dbRepository';

let directory: string;
const originalDir = process.env.MICHI_DATA_DIR;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-v3-state-'));
    process.env.MICHI_DATA_DIR = directory; closeDb(); initDb(); clearAllSessions();
    saveWorkspace({ id: 'ws', name: 'Test', cwd: directory, owner_user_id: 'alice', created_at: 1, updated_at: 1 });
    saveNode({ id: 'node', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    updateNodeResumeBinding('node', { acp_session_id: 'old-native', runtime_id: 'kiro', runtime_engine: 'v3', model_id: 'm1', reasoning: 'low' });
});
afterEach(() => {
    clearAllSessions(); closeDb(); fs.rmSync(directory, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDir;
});
function session(nativeSessionId = 'old-native'): AgentSession {
    return { id: 'node', nativeSessionId, runtimeId: 'kiro', nativeEngine: 'v3', currentModelId: 'm1',
        getHistory: () => [], getPendingAssistant: () => undefined, async *send() {}, async cancel() {},
        getSessionState: () => ({ runtimeId: 'kiro', modelId: 'm1', reasoning: 'low', commands: [{ name: 'context' }] }),
    };
}

test('session settings survive SQLite restart and cannot cross owner, engine or native binding', () => {
    const active = session(); const state = { runtimeId: 'kiro', modelId: 'm2', reasoning: 'high' as const, currentModeId: 'plan' };
    persistSessionState(active, 'bob', state); assert.equal(getNode('node')?.model_id, 'm1');
    persistSessionState({ ...active, nativeEngine: 'v2' }, 'alice', state); assert.equal(getNode('node')?.model_id, 'm1');
    persistSessionState(session('stale-native'), 'alice', state); assert.equal(getNode('node')?.model_id, 'm1');
    persistSessionState(active, 'alice', state);
    closeDb(); initDb();
    assert.equal(getNode('node')?.model_id, 'm2'); assert.equal(getNode('node')?.reasoning, 'high');
    assert.equal(getNode('node')?.current_mode_id, 'plan'); assert.equal(getNode('node')?.acp_session_id, 'old-native');
});

test('state feed replays only owned snapshots and detaches retired session listeners', () => {
    let notify!: () => void; let detached = 0;
    const active = session(); active.onSessionState = (fn) => { notify = fn; return () => { detached++; }; };
    registerSession(active, 'alice');
    const received: unknown[] = [], other: unknown[] = [];
    const stop = subscribeSessionStates((id, state) => received.push({ id, state }), 'alice');
    const stopOther = subscribeSessionStates((_id, state) => other.push(state), 'bob');
    assert.equal(received.length, 1); assert.equal(other.length, 0);
    notify(); assert.equal(received.length, 2); assert.equal(other.length, 0);
    dropSession('node'); notify(); assert.equal(received.length, 2); assert.equal(detached, 1);
    stop(); stopOther();
});
