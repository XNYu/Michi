import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { registerSession, getSession, clearAllSessions, dropSession } from '../src/agents/sessionRegistry';
import { subscribeSessionStates } from '../src/agents/sessionStateFeed';
import { persistSessionState } from '../src/services/sessionStatePersistence';
import { resetKiroContext } from '../src/services/resetKiroContext';
import { closeDb, initDb } from '../src/services/db';
import { saveWorkspace, saveNode, getNode, updateNodeResumeBinding } from '../src/services/dbRepository';
import { chatHub } from '../src/agents/chatHub';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { michiTestHost } from './helpers/michiTestHost';

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
/** The descriptor fact resetKiroContext reads: /clear replaces the native session (Kiro v3). */
const CLEAR_REPLACES_SESSION = { topology: { clearCreatesNewNativeSession: true } };
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

test('a Crew session persists its settings under the crew runtime id', async (t) => {
    updateNodeResumeBinding('node', { acp_session_id: 'crew-native', runtime_id: 'crew', runtime_engine: 'v2', model_id: 'm1', reasoning: 'low' });
    t.mock.method(AcpClient.prototype, 'start', () => {});
    t.mock.method(AcpClient.prototype, 'initialize', async () => ({}));
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
    const runtime = new KiroRuntime({ bridge, defaultCwd: directory, host: michiTestHost(), id: 'crew', engine: 'v2' });
    try {
        const client = await runtime.ensureClient(directory);
        (client as any).dispatch({ method: 'session/update', params: { sessionId: 'crew-native', update: {
            sessionUpdate: 'config_option_update',
            configOptions: [{ id: 'model', type: 'select', currentValue: 'm2', options: [{ value: 'm1' }, { value: 'm2' }] }],
        } } });
        const crew = new KiroSession('node', 'crew-native', runtime, directory, { runtimeId: 'crew' });
        persistSessionState(crew, 'alice', crew.getSessionState());
        assert.equal(getNode('node')?.model_id, 'm2');
    } finally {
        await runtime.shutdown();
    }
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

test('failed /clear preserves old durable identity for recovery and refuses active turns', async (t) => {
    const active = session(); registerSession(active, 'alice'); let created = 0;
    registerRuntime({ id: 'kiro', descriptor: CLEAR_REPLACES_SESSION, releaseSession: async () => {},
        newSession: async () => { created++; throw new Error('startup failed'); } } as unknown as AgentRuntime);
    const busy = t.mock.method(chatHub, 'isActive', () => true);
    await assert.rejects(resetKiroContext(active, 'alice'), /still running/); assert.equal(created, 0);
    busy.mock.restore();
    await assert.rejects(resetKiroContext(active, 'alice'), /startup failed/);
    assert.equal(getNode('node')?.acp_session_id, 'old-native'); assert.equal(getSession('node'), undefined);
});

test('/clear waits for a finished turn to finish its runtime cleanup', async (t) => {
    const active = session(); registerSession(active, 'alice'); let created = 0; let released = 0;
    registerRuntime({ id: 'kiro', descriptor: CLEAR_REPLACES_SESSION, releaseSession: async () => { released++; },
        newSession: async () => { created++; throw new Error('startup failed'); } } as unknown as AgentRuntime);
    assert.equal(chatHub.isActive('node'), false);
    const cleaningUp = t.mock.method(chatHub, 'isOwnerTurnActive', (chatId: string) => chatId === 'node');
    await assert.rejects(resetKiroContext(active, 'alice'), /still running/);
    assert.equal(created, 0); assert.equal(released, 0); assert.equal(getSession('node'), active);
    cleaningUp.mock.restore();
    await assert.rejects(resetKiroContext(active, 'alice'), /startup failed/);
    assert.equal(created, 1); assert.equal(released, 1);
});

test('/clear preserves the immutable Agent profile and rejects a changed binding before release', async () => {
    const active = Object.assign(session(), { runtimeProfileHash: 'profile-1', parentChatId: 'parent', getEnableFollowUps: () => false });
    registerSession(active, 'alice');
    const bootstrap = { profileHash: 'profile-1', bootstrapInstructions: 'Use the approved profile.', toolProfile: { allowedToolNames: ['read_file'] } };
    let released = 0;
    const replacement = session('fresh-native');
    registerRuntime({ id: 'kiro', nativeEngine: 'v3', descriptor: CLEAR_REPLACES_SESSION, releaseSession: async () => { released++; }, newSession: async (options: any) => {
        assert.equal(options.bootstrapInstructions, bootstrap.bootstrapInstructions);
        assert.deepEqual(options.toolProfile, bootstrap.toolProfile);
        assert.equal(options.profileHash, bootstrap.profileHash);
        assert.equal(options.enableFollowUps, false);
        assert.equal(options.parentChatId, undefined, 'old ancestor context must not be replayed');
        return replacement;
    } } as unknown as AgentRuntime);
    await assert.rejects(resetKiroContext(active, 'alice'), /original Agent profile/);
    assert.equal(released, 0);
    updateNodeResumeBinding('node', { acp_session_id: 'changed-native', runtime_id: 'kiro', runtime_engine: 'v3' });
    await assert.rejects(resetKiroContext(active, 'alice', bootstrap), /Cannot reset/);
    assert.equal(released, 0);
    updateNodeResumeBinding('node', { acp_session_id: 'old-native', runtime_id: 'kiro', runtime_engine: 'v3' });
    assert.equal(await resetKiroContext(active, 'alice', bootstrap), replacement);
    assert.equal(released, 1);
    assert.equal(replacement.parentChatId, 'parent');
});
