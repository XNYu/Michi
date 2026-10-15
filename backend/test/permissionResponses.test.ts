import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';
import { registerSession, clearAllSessions } from '../src/agents/sessionRegistry';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';

const originalDataDir = process.env.MICHI_DATA_DIR, originalCloud = process.env.MICHI_CLOUD;
afterEach(() => {
    clearAllSessions(); closeDb();
    if (originalDataDir == null) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
    if (originalCloud == null) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
});

test('HTTP permission responses reject stale, disabled, forged and foreign-chat authorizations', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-permission-response-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.MICHI_DATA_DIR = dir; process.env.MICHI_CLOUD = '1';
    closeDb(); initDb();
    saveWorkspace({ id: 'ws', name: 'Approval tests', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
    saveNode({ id: 'a', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    const responses: unknown[] = [];
    registerSession({ id: 'a', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
        send: async function* () {}, cancel: () => {}, respondToPermission: (...args) => responses.push(args),
    }, 'alice');
    let pending: any = { requestId: 10, title: 'shell', options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow Once' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Trust this tool', disabled: true },
        { optionId: 'allow_session', kind: 'allow_session', name: 'Trust all tools for this session' },
    ] };
    t.mock.method(chatHub, 'getPendingPermission', () => pending);
    t.mock.method(chatHub, 'resolvePermission', () => { pending = null; });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { id: req.headers['x-user'] }; next(); });
    app.use('/api', setupMichiRoutes({} as ChatManager));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/a/permission-response`;
    const post = (body: unknown, user = 'alice') => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
    try {
        assert.equal((await post({ requestId: 11, optionId: 'allow_session' })).status, 409);
        assert.equal((await post({ requestId: 10, optionId: 'forged' })).status, 400);
        assert.equal((await post({ requestId: 10, optionId: 'allow_always' })).status, 400);
        assert.equal((await post({ requestId: 10, optionId: 'allow_session' }, 'bob')).status, 404);
        assert.deepEqual(responses, []);
        assert.equal((await post({ requestId: 10, optionId: 'allow_session' })).status, 200);
        assert.deepEqual(responses, [[10, 'allow_session']]);
        assert.equal((await post({ requestId: 10, optionId: 'allow_session' })).status, 409);
        assert.equal(responses.length, 1);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
