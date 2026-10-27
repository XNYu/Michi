import './isolatedConfigDir';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { closeDb, initDb } from '../src/services/db';
import { getNode, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { registerSession, clearAllSessions } from '../src/agents/sessionRegistry';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import type { AgentSession } from '../src/agents/types';

const originalDataDir = process.env.MICHI_DATA_DIR, originalCloud = process.env.MICHI_CLOUD;
afterEach(() => {
    clearAllSessions(); closeDb();
    if (originalDataDir == null) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
    if (originalCloud == null) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
});

test('Claude model commands persist successful switches and reject foreign owners and runtime cleanup tails', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-claude-command-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.MICHI_DATA_DIR = dir; process.env.MICHI_CLOUD = '1';
    closeDb(); initDb();
    saveWorkspace({ id: 'ws', name: 'Claude commands', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
    saveNode({ id: 'a', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0,
        spawned_by_agent: 0, created_at: 1, runtime_id: 'claude', acp_session_id: 'native-a', model_id: 'old-model' });
    const commands: string[] = [];
    const session: AgentSession = {
        id: 'a', runtimeId: 'claude', nativeSessionId: 'native-a', currentModelId: 'old-model',
        getHistory: () => [], getPendingAssistant: () => undefined, send: async function* () {}, cancel: () => {},
        getSessionState: () => ({ runtimeId: 'claude', nativeEngine: 'agent-sdk', modelId: session.currentModelId }),
        executeCommand: async (command, args) => {
            commands.push(command);
            if (args?.value === 'unsupported') return { success: false, message: 'Unknown model' };
            session.currentModelId = args?.value as string;
            return { success: true, message: 'Model changed' };
        },
    };
    registerSession(session, 'alice');
    let ownerActive = false;
    t.mock.method(chatHub, 'isActive', () => false);
    t.mock.method(chatHub, 'isOwnerTurnActive', () => ownerActive);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { id: req.headers['x-user'] }; next(); });
    app.use('/api', setupMichiRoutes({} as ChatManager));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/a/execute-command`;
    const post = (value: string, user = 'alice') => fetch(base, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify({ command: 'model', args: { value } }) });
    try {
        assert.equal((await post('new-model', 'bob')).status, 404);
        ownerActive = true;
        assert.equal((await post('new-model')).status, 409);
        assert.deepEqual(commands, []);
        ownerActive = false;
        assert.equal((await post('unsupported')).status, 200);
        assert.equal(getNode('a')?.model_id, 'old-model');
        const response = await post('new-model');
        assert.equal(response.status, 200);
        assert.equal((await response.json() as any).sessionState.modelId, 'new-model');
        assert.equal(getNode('a')?.model_id, 'new-model');
        assert.equal(getNode('a')?.acp_session_id, 'native-a');
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
