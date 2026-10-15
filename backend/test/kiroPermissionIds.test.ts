import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { parseChatStreamEvent } from 'michi-shared';
import { AcpClient } from '../src/services/acpClient';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { toChatStreamEvent } from '../src/routes/chatStreamEvents';
import { setupMichiRoutes } from '../src/routes/michi';
import { ChatManager } from '../src/services/chatManager';
import { chatHub } from '../src/agents/chatHub';
import { registerSession, clearAllSessions } from '../src/agents/sessionRegistry';
import { initDb, closeDb, getDb } from '../src/services/db';

for (const choice of ['allow-once', 'deny', 'cancel']) test(`UUID permission survives adapter, stream parser and HTTP ${choice}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-permission-id-'));
    const original = process.env.MICHI_DATA_DIR;
    process.env.MICHI_DATA_DIR = directory;
    closeDb(); initDb();
    getDb().prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('ws','Test',1,1)").run();
    getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at) VALUES ('node','ws','chat','idle',0,0,1)").run();
    const c = new AcpClient('/bin/false', '/tmp', undefined, 'v3');
    const internal = c as any;
    const writes: any[] = [];
    let complete!: (value: unknown) => void;
    internal.proc = { stdin: { destroyed: false, write: (line: string) => { writes.push(JSON.parse(line)); complete({ stopReason: 'end_turn' }); } } };
    internal.send = async (method: string) => {
        if (method === 'session/new') return { sessionId: 'native' };
        if (method === 'session/prompt') {
            internal.dispatch({ jsonrpc: '2.0', id: 'uuid-permission-123', method: 'session/request_permission', params: {
                sessionId: 'native', toolCall: { toolCallId: 'call-1', title: 'Run command' },
                options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow Once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
            } });
            return new Promise((resolve) => { complete = resolve; });
        }
        return {};
    };
    await c.newSession();
    const runtime = { engine: 'v3', ensureClient: async () => c,
        respondToPermission: (_sid: string, id: number, option: string) => c.respondToPermission(id, option),
        cancelPermission: (_sid: string, id: number) => c.cancelPermission(id),
    } as unknown as KiroRuntime;
    const session = new KiroSession('node', 'native', runtime, '/tmp');
    registerSession(session, null);
    const stream = session.send('please run');
    let next = await stream.next();
    while (!next.done && next.value.kind !== 'permission_request') next = await stream.next();
    assert.ok(!next.done && next.value.kind === 'permission_request');
    const event = toChatStreamEvent(next.value);
    const parsed = parseChatStreamEvent(event.event, JSON.stringify(event.data));
    assert.ok(parsed?.event === 'permission_request');
    assert.equal(typeof parsed.data.requestId, 'number');
    assert.notEqual(parsed.data.requestId, 0);
    t.mock.method(chatHub, 'getPendingPermission', () => parsed.data);
    t.mock.method(chatHub, 'resolvePermission', () => {});
    const app = express(); app.use(express.json()); app.use('/api', setupMichiRoutes(new ChatManager(undefined, directory)));
    const server = app.listen(0);
    try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/node/permission-response`;
        const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal((await post({ requestId: 0, optionId: choice })).status, 409);
        const response = await post({ requestId: parsed.data.requestId, ...(choice === 'cancel' ? { cancel: true } : { optionId: choice }) });
        assert.equal(response.status, 200, await response.text());
        assert.deepEqual(writes, [{ jsonrpc: '2.0', id: 'uuid-permission-123', result: { outcome: choice === 'cancel'
            ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: choice } } }]);
        for await (const _ of stream) {}
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        clearAllSessions(); closeDb();
        if (original === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = original;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('numeric and UUID IDs cannot overwrite pending permissions; automatic cancellation retains wire ID', async () => {
    const c = new AcpClient('/bin/false', '/tmp', undefined, 'v3');
    const internal = c as any;
    internal.send = async () => ({ sessionId: 'native' });
    await c.newSession();
    const writes: any[] = [];
    internal.proc = { stdin: { destroyed: false, write: (line: string) => writes.push(JSON.parse(line)) } };
    for (const id of [-1, 'uuid-a', -2, 'uuid-b']) internal.dispatch({ id, method: 'session/request_permission', params: { sessionId: 'native' } });
    assert.equal(internal.pendingPermissions.size, 4);
    c.cancelPermissionsForSession('native');
    internal.dispatch({ id: 'uuid-unknown', method: 'session/request_permission', params: { sessionId: 'unknown' } });
    internal.quarantinedSessions.add('native');
    internal.dispatch({ id: 'uuid-late', method: 'session/request_permission', params: { sessionId: 'native' } });
    assert.deepEqual(writes.map((r) => r.id), [-1, 'uuid-a', -2, 'uuid-b', 'uuid-unknown', 'uuid-late']);
    assert.equal(internal.pendingPermissions.size, 0);
});
